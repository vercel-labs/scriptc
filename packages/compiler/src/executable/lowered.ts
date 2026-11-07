/* A build's lowered program as a file.
 *
 * `--emit-lowered <file>` writes what the frontend hands the backend when it
 * is done: the validated IR module, the source texts that code frames and
 * debug information read, the warnings the build reports, its lowering
 * statistics and its Node islands. `--from-lowered <file>` starts a build
 * from such a file instead of running the frontend, so the phases behind
 * lowering (IR validation, LLVM emission, native code generation, the link)
 * can be run again without it.
 *
 * The build caches cannot serve that purpose: the compiler is one of their
 * keys, and the point of resuming is to run a changed compiler. So the file
 * records what the lowered program depended on, and a build that starts from
 * it checks each of them and refuses the file by name when one differs:
 *
 * - `compiler`: the build of the compiler that lowered it;
 * - `options`: the entry, the target platform, the FFI manifest, every
 *   option but the output paths, and the SCRIPTC_* variables the frontend
 *   reads (frontend/environment.ts);
 * - `inputs`: every file, directory listing and path the frontend observed
 *   (frontend/input-tracker.ts), replayed against the file system.
 *
 * `--from-lowered-accept=<kind>[,<kind>]` builds from the file although the
 * named kinds differ, and says on stderr what differed. A file written with
 * another IR layout or IR version cannot be read and is never accepted.
 *
 * A file that holds only an IR module (`--emit=ir`) records none of this,
 * so it is accepted only with all three kinds named.
 *
 * Layout, in the IR codec's primitives (ir/codec.ts): the magic and a
 * version byte, the IR layout digest and IR version, the manifest as JSON,
 * the input probes as JSON arrays of bounded size, the source texts, and
 * the module. The module is its JSON encoding without the functions
 * (ir/serialize.ts), then each function in the binary encoding when that
 * reads back as the function is (IrWriter.inOrder), and as JSON otherwise:
 * either way an object is read back with its own keys in its own order, so
 * the build emits from the module the frontend made. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CompileFailure, CompileRequestOptions } from "../compile-types.js";
import { iceDiag, nativeCodegenDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { frontendEnvironment } from "../frontend/environment.js";
import {
  changedFrontendInput,
  invalidateTrackedPath,
  markFrontendInputsUnstable,
  observeFrontendInputs,
  validFrontendInputSnapshot,
  type FrontendInputExclusions,
  type FrontendInputProbe,
  type FrontendInputSnapshot,
} from "../frontend/input-tracker.js";
import type { LowerStats } from "../frontend/lowering/lowerer.js";
import { provenanceSources } from "../frontend/provenance-registry.js";
import { IrReader, IrWriter, encodeFunctionInOrder } from "../ir/codec.js";
import { IR_CODEC_LAYOUT, decodeIrFunction, encodeIrFunction } from "../ir/codec.generated.js";
import type { IrFunction, IrModule } from "../ir/ir.js";
import {
  IR_VERSION,
  deserializeFunction,
  deserializeModuleBytes,
  encodeFunction,
  serializeModuleParts,
} from "../ir/serialize.js";
import { validateModule } from "../ir/validate.js";
import type { CompilationTiming } from "../timing.js";
import type { PreparedExecutableModule } from "./prepare.js";

/** What a lowered program depended on, by the name `--from-lowered-accept`
 * takes. */
export const LOWERED_DEPENDENCIES = ["compiler", "options", "inputs"] as const;
export type LoweredDependency = (typeof LOWERED_DEPENDENCIES)[number];

export function isLoweredDependency(value: string): value is LoweredDependency {
  return (LOWERED_DEPENDENCIES as readonly string[]).includes(value);
}

/** The options lowering can read: every one but the output paths and the
 * lowered-program options themselves. */
export function loweringOptions(
  options: CompileRequestOptions,
): Omit<
  CompileRequestOptions,
  "outPath" | "outDir" | "emitLowered" | "fromLowered" | "fromLoweredAccept"
> {
  const {
    outPath: _outPath,
    outDir: _outDir,
    emitLowered: _emitLowered,
    fromLowered: _fromLowered,
    fromLoweredAccept: _fromLoweredAccept,
    ...lowering
  } = options;
  return lowering;
}

/** What the driver knows about the build in progress. */
export interface LoweredBuild {
  /** The identity of this build of the compiler: the one the driver's caches
   * key by. Read only by a build that writes or reads a lowered program. */
  compiler: () => string;
  /** The paths this build writes, which the frontend's probes do not
   * observe. */
  outputs: readonly string[];
}

/** The first bytes of a lowered program: "SCLP". */
const MAGIC = [0x53, 0x43, 0x4c, 0x50];
const FORMAT = 1;
/** Input probes per JSON array: each stays far below one native string. */
const PROBES_PER_PART = 2048;
/** How a function is stored. */
const FUNCTION_BINARY = 0;
const FUNCTION_JSON = 1;

interface LoweredManifest {
  schema: "scriptc.lowered.v1";
  compiler: string;
  entry: string;
  platform: string;
  /** A digest of the FFI manifest's bytes, or null without one. */
  ffi: string | null;
  options: Record<string, unknown>;
  environment: [string, string][];
  /** What the writing build wrote, this file included. */
  outputs: string[];
  /** Whether the frontend observed every input it read (a host API that
   * resolves by itself reports none). */
  stable: boolean;
  stats: LowerStats;
  islands: { packages: string[]; modules: string[] } | null;
  warnings: ScrDiagnostic[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validManifest(value: unknown): value is LoweredManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  const options = manifest["options"];
  const stats = manifest["stats"];
  const islands = manifest["islands"];
  const environment = manifest["environment"];
  if (
    manifest["schema"] !== "scriptc.lowered.v1" ||
    typeof manifest["compiler"] !== "string" ||
    typeof manifest["entry"] !== "string" ||
    typeof manifest["platform"] !== "string" ||
    (manifest["ffi"] !== null && typeof manifest["ffi"] !== "string") ||
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    !Array.isArray(environment) ||
    !isStringArray(manifest["outputs"]) ||
    typeof manifest["stable"] !== "boolean" ||
    stats === null ||
    typeof stats !== "object" ||
    !Array.isArray(manifest["warnings"])
  )
    return false;
  if (!environment.every((pair) => isStringArray(pair) && pair.length === 2)) return false;
  const counts = stats as Record<string, unknown>;
  if (
    typeof counts["statementsTotal"] !== "number" ||
    typeof counts["statementsFailed"] !== "number" ||
    typeof counts["functionsSkipped"] !== "number"
  )
    return false;
  if (islands !== null) {
    if (typeof islands !== "object" || Array.isArray(islands)) return false;
    const sets = islands as Record<string, unknown>;
    if (!isStringArray(sets["packages"]) || !isStringArray(sets["modules"])) return false;
  }
  return (manifest["warnings"] as unknown[]).every((warning) => {
    if (warning === null || typeof warning !== "object") return false;
    const diagnostic = warning as Record<string, unknown>;
    const loc = diagnostic["loc"];
    return (
      typeof diagnostic["code"] === "string" &&
      typeof diagnostic["message"] === "string" &&
      loc !== null &&
      typeof loc === "object"
    );
  });
}

/** A digest of the FFI manifest's bytes, or null without one. The bytes,
 * not the parsed profile: a file one compiler writes is read by the other
 * (the Node-hosted one and the native one), and the JSON text of their
 * profile objects need not be the same. */
function ffiDigest(options: CompileRequestOptions): string | null {
  if (options.ffiProfilePath === undefined) return null;
  try {
    return createHash("sha256")
      .update(readFileSync(resolve(options.ffiProfilePath)))
      .digest("hex");
  } catch {
    // The driver loaded the manifest before the frontend ran, so a build
    // does not get here without one.
    return "unreadable";
  }
}

/** What this build would record: the manifest's dependencies. */
function buildManifest(
  entryPath: string,
  options: CompileRequestOptions,
  buildPlatform: string,
  build: LoweredBuild,
): Pick<
  LoweredManifest,
  "compiler" | "entry" | "platform" | "ffi" | "options" | "environment" | "outputs"
> {
  const environment: [string, string][] = [];
  for (const [name, value] of frontendEnvironment()) environment.push([name, value ?? ""]);
  return {
    compiler: build.compiler(),
    entry: resolve(entryPath),
    platform: buildPlatform,
    ffi: ffiDigest(options),
    // Through JSON, as a file's manifest is read: without absent options.
    options: JSON.parse(JSON.stringify(loweringOptions(options))) as Record<string, unknown>,
    environment,
    outputs: build.outputs.map((path) => resolve(path)),
  };
}

/** The bytes of a lowered program. */
export function encodeLoweredProgram(
  prepared: PreparedExecutableModule,
  dependencies: Pick<
    LoweredManifest,
    "compiler" | "entry" | "platform" | "ffi" | "options" | "environment" | "outputs"
  >,
  inputs: FrontendInputSnapshot,
): Buffer {
  const manifest: LoweredManifest = {
    schema: "scriptc.lowered.v1",
    ...dependencies,
    stable: inputs.stable,
    stats: prepared.stats,
    islands: prepared.islands ?? null,
    warnings: prepared.warnings,
  };
  const w = new IrWriter();
  for (const byte of MAGIC) w.byte(byte);
  w.byte(FORMAT);
  w.str(IR_CODEC_LAYOUT);
  w.length(IR_VERSION);
  w.str(JSON.stringify(manifest));
  w.length(Math.ceil(inputs.probes.length / PROBES_PER_PART));
  for (let start = 0; start < inputs.probes.length; start += PROBES_PER_PART)
    w.str(JSON.stringify(inputs.probes.slice(start, start + PROBES_PER_PART)));
  w.length(prepared.sourceTexts.size);
  for (const [path, text] of prepared.sourceTexts) {
    w.str(path);
    w.str(text);
  }
  const mod = prepared.mod;
  w.str(serializeModuleParts({ ...mod, functions: [] }).join(""));
  w.length(mod.functions.length);
  for (const fn of mod.functions) {
    // The binary decoder builds every object with its declared fields in
    // declared order; a function holding an object in another shape keeps
    // it through JSON.
    if (encodeFunctionInOrder(fn) !== null) {
      w.byte(FUNCTION_BINARY);
      encodeIrFunction(w, fn);
    } else {
      w.byte(FUNCTION_JSON);
      w.str(encodeFunction(fn) ?? "null");
    }
  }
  return w.finish();
}

/** A lowered program read up to its sources: `rest` decodes those and the
 * module, which a refused file never needs. `manifest` and `inputs` are null
 * for a file that holds only an IR module. */
export interface LoweredProgram {
  manifest: LoweredManifest | null;
  inputs: FrontendInputSnapshot | null;
  rest: () => { mod: IrModule; sourceTexts: Map<string, string> };
}

/** Whether `bytes` start like a lowered program. */
export function isLoweredProgram(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Reads a lowered program, or an IR artifact. Throws an Error that says
 * why the bytes cannot be read. */
export function decodeLoweredProgram(bytes: Buffer): LoweredProgram {
  if (!isLoweredProgram(bytes)) {
    return {
      manifest: null,
      inputs: null,
      rest: () => ({ mod: deserializeModuleBytes(bytes), sourceTexts: new Map() }),
    };
  }
  const r = new IrReader(bytes);
  for (const byte of MAGIC) if (r.byte() !== byte) throw new Error("not a lowered program");
  const format = r.byte();
  if (format !== FORMAT)
    throw new Error(`it has format ${format}, and this compiler reads format ${FORMAT}`);
  const layout = r.str();
  const version = r.length();
  if (layout !== IR_CODEC_LAYOUT || version !== IR_VERSION)
    throw new Error(
      `it holds IR version ${version} in layout ${layout}, and this compiler reads version ${IR_VERSION} in layout ${IR_CODEC_LAYOUT}`,
    );
  const manifest: unknown = JSON.parse(r.str());
  if (!validManifest(manifest)) throw new Error("its manifest is malformed");
  const probes: FrontendInputProbe[] = [];
  const parts = r.length();
  for (let part = 0; part < parts; part++) {
    const parsed: unknown = JSON.parse(r.str());
    if (!Array.isArray(parsed)) throw new Error("its input probes are malformed");
    for (const probe of parsed as FrontendInputProbe[]) probes.push(probe);
  }
  // The shape check reads `stable` as the caches do; the manifest keeps the
  // recorded answer.
  const inputs: FrontendInputSnapshot = { version: 1, probes, stable: true };
  if (!validFrontendInputSnapshot(inputs)) throw new Error("its input probes are malformed");
  inputs.stable = manifest.stable;
  return {
    manifest,
    inputs,
    rest: () => {
      const sourceTexts = new Map<string, string>();
      const count = r.length();
      for (let index = 0; index < count; index++) {
        const path = r.str();
        sourceTexts.set(path, r.str());
      }
      const mod = deserializeModuleBytes(Buffer.from(r.str(), "utf8"));
      const functions: IrFunction[] = [];
      const total = r.length();
      for (let index = 0; index < total; index++) {
        const stored = r.byte();
        if (stored === FUNCTION_BINARY) functions.push(decodeIrFunction(r));
        else if (stored === FUNCTION_JSON) functions.push(deserializeFunction(r.str()));
        else throw new Error("a function is stored in a form this compiler does not read");
      }
      if (!r.done()) throw new Error("it has bytes after the module");
      mod.functions = functions;
      return { mod, sourceTexts };
    },
  };
}

/** A dependency of a lowered program that this build does not share. */
export interface LoweredMismatch {
  kind: LoweredDependency;
  detail: string;
}

function describeProbe(probe: FrontendInputProbe): string {
  switch (probe.op) {
    case "file":
    case "bytes":
    case "text":
      return `${probe.path} changed`;
    case "read-error":
      return `${probe.path} can be read now`;
    case "kind":
      return probe.kind === "missing"
        ? `${probe.path} exists now`
        : `${probe.path} is no longer a ${probe.kind === "other" ? "special file" : probe.kind}`;
    case "entries":
    case "entries-error":
      return `the entries of directory ${probe.path} changed`;
    case "realpath":
      return `${probe.path} resolves to another path`;
    case "host":
      // A host fact's name (hostFact): an environment variable, the working
      // directory, or the compiler's installation prefix.
      return probe.path.startsWith("env:")
        ? `the environment variable ${probe.path.slice(4)} changed`
        : probe.path === "cwd"
          ? "the working directory changed"
          : "the compiler's installation prefix changed";
  }
}

/** The output paths with every directory above them, as the probe replay
 * takes them. */
function outputExclusions(paths: readonly string[]): FrontendInputExclusions {
  const directories = new Set<string>();
  for (const output of paths) {
    for (let directory = dirname(output); ; directory = dirname(directory)) {
      directories.add(directory);
      if (dirname(directory) === directory) break;
    }
  }
  return { outputPaths: [...paths], outputDirectories: [...directories] };
}

/** How the build that wrote `program` differs from this one, one entry per
 * kind at most. */
export function loweredMismatches(
  program: LoweredProgram,
  current: Pick<
    LoweredManifest,
    "compiler" | "entry" | "platform" | "ffi" | "options" | "environment" | "outputs"
  >,
): LoweredMismatch[] {
  const { manifest, inputs } = program;
  if (manifest === null || inputs === null) {
    return LOWERED_DEPENDENCIES.map((kind) => ({
      kind,
      detail: `the file holds only an IR module, which does not record its ${kind}`,
    }));
  }
  const mismatches: LoweredMismatch[] = [];
  if (manifest.compiler !== current.compiler) {
    mismatches.push({
      kind: "compiler",
      detail: `it was lowered by another build of the compiler (${manifest.compiler.slice(0, 12)}; this one is ${current.compiler.slice(0, 12)})`,
    });
  }
  const differing: string[] = [];
  if (manifest.entry !== current.entry) differing.push(`the entry (${manifest.entry})`);
  if (manifest.platform !== current.platform)
    differing.push(`the target platform (${manifest.platform})`);
  if (manifest.ffi !== current.ffi) differing.push("the FFI manifest");
  const optionNames = new Set([...Object.keys(manifest.options), ...Object.keys(current.options)]);
  for (const name of [...optionNames].sort()) {
    if (JSON.stringify(manifest.options[name]) !== JSON.stringify(current.options[name]))
      differing.push(`option ${name}`);
  }
  const before = new Map(manifest.environment);
  const now = new Map(current.environment);
  for (const name of [...new Set([...before.keys(), ...now.keys()])].sort()) {
    if (before.get(name) !== now.get(name)) differing.push(`environment variable ${name}`);
  }
  if (differing.length > 0) {
    mismatches.push({
      kind: "options",
      detail: `the build that wrote it differs in ${differing.join(", ")}`,
    });
  }
  const changed = changedFrontendInput(
    inputs,
    outputExclusions([...manifest.outputs, ...current.outputs]),
  );
  if (changed !== null) {
    mismatches.push({ kind: "inputs", detail: `${describeProbe(changed)} since it was lowered` });
  }
  return mismatches;
}

function refusal(entryPath: string, message: string, hint?: string): CompileFailure {
  return {
    ok: false,
    diagnostics: [nativeCodegenDiag("SC3002", message, entryPath, hint)],
    sourceTexts: new Map(),
  };
}

/** The request's own contradictions, or null. */
function optionRefusal(entryPath: string, options: CompileRequestOptions): CompileFailure | null {
  if (options.emitLowered !== undefined && options.fromLowered !== undefined)
    return refusal(
      entryPath,
      "--emit-lowered and --from-lowered cannot be combined: a build from a lowered program lowers nothing",
    );
  if (options.fromLoweredAccept !== undefined && options.fromLowered === undefined)
    return refusal(entryPath, "--from-lowered-accept needs --from-lowered");
  // Provenance rewriting replaces the sources with build products that
  // neither the options nor the input probes describe.
  if (provenanceSources() !== null)
    return refusal(
      entryPath,
      "--emit-lowered and --from-lowered cannot be combined with --provenance-sources",
    );
  return null;
}

/** Whether a build writes or reads a lowered program. Such a build takes no
 * result from the build caches and leaves none. */
export function usesLoweredProgram(options: CompileRequestOptions): boolean {
  return (
    options.emitLowered !== undefined ||
    options.fromLowered !== undefined ||
    options.fromLoweredAccept !== undefined
  );
}

function writeLoweredProgram(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const stage = `${path}.${process.pid}.tmp`;
  writeFileSync(stage, bytes);
  renameSync(stage, path);
  invalidateTrackedPath(path);
}

function fromLoweredProgram(
  entryPath: string,
  options: CompileRequestOptions,
  buildPlatform: string,
  timing: CompilationTiming,
  build: LoweredBuild,
  path: string,
): PreparedExecutableModule | CompileFailure {
  let bytes: Buffer;
  let program: LoweredProgram;
  try {
    bytes = readFileSync(path);
    program = decodeLoweredProgram(bytes);
  } catch (error) {
    return refusal(
      entryPath,
      `--from-lowered: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "write the file again with --emit-lowered",
    );
  }
  const current = buildManifest(entryPath, options, buildPlatform, {
    compiler: build.compiler,
    outputs: [...build.outputs, path],
  });
  const accepted = new Set<string>(options.fromLoweredAccept ?? []);
  const mismatches = loweredMismatches(program, current);
  const refused = mismatches.filter((mismatch) => !accepted.has(mismatch.kind));
  if (refused.length > 0) {
    return {
      ok: false,
      diagnostics: refused.map((mismatch) =>
        nativeCodegenDiag(
          "SC3002",
          `--from-lowered: ${path} does not match this build's ${mismatch.kind}: ${mismatch.detail}`,
          entryPath,
          `lower the program again with --emit-lowered, or pass --from-lowered-accept=${mismatch.kind} to build from the file anyway`,
        ),
      ),
      sourceTexts: new Map(),
    };
  }
  for (const mismatch of mismatches)
    process.stderr.write(
      `scriptc: warning: --from-lowered: building from ${path} although its ${mismatch.kind} differ${mismatch.kind === "compiler" ? "s" : ""}: ${mismatch.detail}\n`,
    );
  if (program.manifest !== null && !program.manifest.stable && mismatches.length === 0)
    process.stderr.write(
      `scriptc: note: --from-lowered: the build that wrote ${path} could not observe every input it read; the ones it observed are unchanged\n`,
    );
  // The build's own caches describe what this compiler makes of these
  // inputs, which a program lowered elsewhere is not known to be.
  markFrontendInputsUnstable();
  let mod: IrModule;
  let sourceTexts: Map<string, string>;
  try {
    const rest = program.rest();
    mod = rest.mod;
    sourceTexts = rest.sourceTexts;
  } catch (error) {
    return refusal(
      entryPath,
      `--from-lowered: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "write the file again with --emit-lowered",
    );
  }
  if (program.manifest === null) {
    if (resolve(mod.sourceFile) !== resolve(entryPath))
      return refusal(
        entryPath,
        `--from-lowered: ${path} was lowered from another entry (${mod.sourceFile})`,
      );
    // Line tables are built from the source texts, which an IR module does
    // not carry.
    if (options.optimization === "dev" && options.strip !== true)
      return refusal(
        entryPath,
        `--from-lowered: ${path} holds only an IR module, without the sources debug information reads; build with --strip or another optimization`,
      );
  }
  timing("lowered-read", { bytes: bytes.length, functions: mod.functions.length });
  const validation = validateModule(mod);
  timing("ir-validate");
  if (validation.length > 0) {
    return {
      ok: false,
      diagnostics: validation.map((v) => iceDiag(v.message, v.loc)),
      sourceTexts,
    };
  }
  const manifest = program.manifest;
  return {
    ok: true,
    mod,
    sourceTexts,
    stats:
      manifest === null
        ? { statementsTotal: 0, statementsFailed: 0, functionsSkipped: 0 }
        : manifest.stats,
    warnings: manifest === null ? [] : manifest.warnings,
    ...(manifest === null || manifest.islands === null ? {} : { islands: manifest.islands }),
  };
}

/** The frontend's part of an executable build: `prepare` (the frontend), or
 * the lowered program `--from-lowered` names; with `--emit-lowered`, what
 * `prepare` returned is also written to that file. A build with neither
 * option is `prepare()`. */
export function prepareLoweredProgram(
  entryPath: string,
  options: CompileRequestOptions,
  buildPlatform: string,
  timing: CompilationTiming,
  build: LoweredBuild,
  prepare: () => PreparedExecutableModule | CompileFailure,
): PreparedExecutableModule | CompileFailure {
  if (!usesLoweredProgram(options)) return prepare();
  const refused = optionRefusal(entryPath, options);
  if (refused !== null) return refused;
  if (options.fromLowered !== undefined)
    return fromLoweredProgram(
      entryPath,
      options,
      buildPlatform,
      timing,
      build,
      resolve(options.fromLowered),
    );
  const path = resolve(options.emitLowered!);
  const { result: prepared, inputs } = observeFrontendInputs(prepare);
  if (!prepared.ok) return prepared;
  try {
    const bytes = encodeLoweredProgram(
      prepared,
      buildManifest(entryPath, options, buildPlatform, {
        compiler: build.compiler,
        outputs: [...build.outputs, path],
      }),
      inputs,
    );
    writeLoweredProgram(path, bytes);
    timing("lowered-write", { bytes: bytes.length, functions: prepared.mod.functions.length });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag(
          "SC3002",
          `--emit-lowered: cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
          entryPath,
        ),
      ],
      sourceTexts: prepared.sourceTexts,
    };
  }
  return prepared;
}
