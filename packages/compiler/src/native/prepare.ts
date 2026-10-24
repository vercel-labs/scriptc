import { targetCpuField, targetCpuTargetRefusal } from "../backend/target-cpu.js";
import { nativeCodegenDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { CompilationTiming } from "../timing.js";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CompileFailure,
  CompileLibraryOptions,
  CompileRequestOptions,
} from "../compile-types.js";
import {
  emitLlvmModuleParts,
  type ForkPrimitives,
  lowRegionTarget,
} from "../backend/llvm/emitter.js";
import { inlineRcOption } from "../backend/llvm/shapes.js";
import { executableLinkFeatures } from "../backend/executable-features.js";
import type { NativeLinkFeatures } from "../backend/native-link-info-core.js";
import { prepareExecutableModule } from "../executable/prepare.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import {
  FrontendInputTracker,
  frontendInputsSemanticallyMatch,
  frontendInputsStillMatch,
  validFrontendInputSnapshot,
  type FrontendInputSnapshot,
  type FrontendInputExclusions,
  trackedReadFile,
} from "../frontend/input-tracker.js";
import { compilerOwnedFileRoots } from "../frontend/dts-paths.js";
import { provenanceSources } from "../frontend/provenance-registry.js";
import { processFork } from "../frontend/process-fork.js";
import { tokenEquivalentSource } from "../frontend/token-equivalence.js";
import { llvmBytes, wtf8Bytes } from "../backend/literals.js";
import { prepareLibrary } from "../library/prepare.js";
import type { LibraryProfile } from "../library/library-profile.js";
import type { IrModule } from "../ir/ir.js";
import { deserializeModuleBytes, serializeModuleParts } from "../ir/serialize.js";
import { contentDigest, NATIVE_STRING_BYTES, type NativeCache } from "./cache.js";
import { batchTextParts, joinedParts, textSlices } from "./text-file.js";
import type { NativeToolchain } from "./toolchain.js";
import { nativeFileIdentity } from "./file-identity.js";

export interface NativeExecutableInput {
  ok: true;
  /** The module's LLVM text as parts that concatenate to it
   * (emitLlvmModuleParts), never joined: a large program's is 150 MB. */
  llvm: readonly string[];
  /** Compact serialized IR as bounded parts (`batchTextParts`): compiler-scale
   * modules exceed one native string. */
  ir: string[] | null;
  sidecarJson: string | null;
  features: NativeLinkFeatures;
  sources: [string, string][];
  /** Divergence warnings (SC6xxx) the lowering found; cached with the
   * input so a frontend-cache hit reports them too. */
  warnings?: ScrDiagnostic[];
}

/** The two large artifacts follow the input metadata as separate members so
 * an entry can be written as parts instead of one JSON string; the stored
 * input carries empty placeholders (`[]`, `null`) for them. */
interface FrontendCacheEntry {
  schema: "scriptc.native-frontend.v3";
  probes: FrontendInputSnapshot;
  input: NativeExecutableInput;
  llvm: string;
  ir: string[] | null;
}

/** The entry's JSON text, generated as it is written. The LLVM text is
 * escaped in slices (`textSlices`), the same JSON string as escaping it
 * whole, so a large module is never copied whole. */
function* frontendCacheParts(
  probes: FrontendInputSnapshot,
  input: NativeExecutableInput,
): Generator<string> {
  const metadata = JSON.stringify({
    schema: "scriptc.native-frontend.v3",
    probes,
    input: { ...input, llvm: [], ir: null },
  });
  yield metadata.slice(0, metadata.length - 1) + ',"llvm":"';
  for (const part of joinedParts(input.llvm))
    for (const slice of textSlices(part)) yield JSON.stringify(slice).slice(1, -1);
  yield '"';
  if (input.ir === null) yield ',"ir":null}';
  else {
    yield ',"ir":[';
    for (let index = 0; index < input.ir.length; index++) {
      if (index > 0) yield ",";
      yield JSON.stringify(input.ir[index]!);
    }
    yield "]}";
  }
}

/** The parts while their total length stays within `limit`; past it, a
 * throw abandons the write. */
function* boundedParts(parts: Generator<string>, limit: number): Generator<string> {
  let length = 0;
  for (const part of parts) {
    length += part.length;
    if (length > limit) throw new Error("frontend cache entry exceeds one native string");
    yield part;
  }
}

/** Publish an entry only when a native reader can decode it as one string;
 * UTF-16 length never exceeds the UTF-8 byte length. A longer entry
 * abandons its write, which writeParts discards. */
function publishFrontendCache(
  cache: NativeCache,
  key: string,
  probes: FrontendInputSnapshot,
  input: NativeExecutableInput,
): void {
  cache.writeParts(
    "frontend",
    key,
    boundedParts(frontendCacheParts(probes, input), NATIVE_STRING_BYTES),
  );
}

/** The cached input when every frontend input still matches, else the
 * entry the inputs no longer match, for reuse after equivalent edits. */
function readFrontendCache(
  cache: NativeCache,
  key: string,
  exclusions: FrontendInputExclusions,
): { input: NativeExecutableInput } | { stale: FrontendCacheEntry } | null {
  // The entry is decoded as one string; larger entries are misses.
  const bytes = cache.read("frontend", key, NATIVE_STRING_BYTES);
  if (bytes === null) return null;
  const cached: unknown = JSON.parse(bytes.toString("utf8"));
  if (!validCachedInput(cached)) return null;
  if (!frontendInputsStillMatch(cached.probes, exclusions)) return { stale: cached };
  return { input: { ...cached.input, llvm: [cached.llvm], ir: cached.ir } };
}

/** The stale entry's input when every changed source is token-equivalent to
 * the text the entry was built from (edits to whitespace and to comments
 * that cannot affect compilation; see token-equivalence.ts). Equivalent
 * sources lower to the same IR apart from source locations, which only dev
 * builds' debug information and the serialized IR carry. Diagnostics carry
 * locations too, so an entry that reported warnings is rebuilt. A changed
 * source whose raw text or line positions the frontend read (call-site text
 * in messages, comptime callbacks, test locations) is rebuilt as well:
 * frontendInputsSemanticallyMatch refuses its `text` probe. */
function equivalentFrontendInput(
  stale: FrontendCacheEntry,
  options: CompileRequestOptions,
  exclusions: FrontendInputExclusions,
): { input: NativeExecutableInput; probes: FrontendInputSnapshot } | null {
  if (
    options.optimization === "dev" ||
    options.sanitize === true ||
    options.emitIr === true ||
    stale.ir !== null ||
    (stale.input.warnings?.length ?? 0) > 0
  )
    return null;
  const match = frontendInputsSemanticallyMatch(
    stale.probes,
    new Map(stale.input.sources),
    tokenEquivalentSource,
    exclusions,
  );
  if (match === null || match.changed.length === 0) return null;
  // Runtime fences and unsupported-construct messages name their source as
  // `[<code> at <file>:<line>]`, and an equivalent edit can move the line.
  if (
    match.changed.some(({ path }) =>
      stale.llvm.includes(` at ${llvmBytes(wtf8Bytes(path), false)}:`),
    )
  )
    return null;
  return {
    input: {
      ...stale.input,
      llvm: [stale.llvm],
      ir: null,
      sources: stale.input.sources.map(([path, text]) => [
        path,
        match.currentSources.get(path) ?? text,
      ]),
    },
    probes: match.snapshot,
  };
}

function implementationIdentity(toolchain: NativeToolchain): string {
  // Release versions alone cannot distinguish two development builds.
  return contentDigest(
    JSON.stringify({
      compiler: nativeFileIdentity(process.execPath),
      checker: nativeFileIdentity(toolchain.ts7Executable),
      evaluator:
        toolchain.comptimeExecutable === undefined
          ? null
          : nativeFileIdentity(toolchain.comptimeExecutable),
      version: toolchain.compilerVersion,
    }),
  );
}

function validFeatures(value: unknown): value is NativeLinkFeatures {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const features = value as Record<string, unknown>;
  if (features["workers"] !== undefined && typeof features["workers"] !== "boolean") return false;
  if (features["youngNursery"] !== undefined && typeof features["youngNursery"] !== "boolean")
    return false;
  return [
    "regex",
    "copying",
    "textDecoderLegacy",
    "fileHandle",
    "fetch",
    "zlib",
    "assert",
    "inspect",
    "dynInvoke",
    "dc",
    "dynAsync",
    "events",
    "emitter",
    "symbol",
    "bigint",
    "searchParams",
    "qs",
    "utilPromisify",
    "dynBuiltinClass",
    "dynBuiltinStream",
    "parseArgs",
    "stream",
    "net",
    "http",
    "http2",
    "dgram",
    "dnsPromises",
    "dgramDyn",
    "textCodecDyn",
    "watch",
    "foreignFfi",
    "nodeTest",
    "tls",
    "tlsCa",
    "cipher",
    "ecdh",
    "dh",
    "pki",
    "ed25519",
    "webcrypto",
    "perfLoop",
  ].every((name) => typeof features[name] === "boolean");
}

function validCachedInput(value: unknown): value is FrontendCacheEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<FrontendCacheEntry>;
  const input = entry.input;
  if (
    entry.schema !== "scriptc.native-frontend.v3" ||
    !validFrontendInputSnapshot(entry.probes) ||
    input === undefined ||
    input === null ||
    typeof input !== "object"
  )
    return false;
  return (
    input.ok === true &&
    typeof entry.llvm === "string" &&
    (entry.ir === null ||
      (Array.isArray(entry.ir) && entry.ir.every((part) => typeof part === "string"))) &&
    (input.sidecarJson === null || typeof input.sidecarJson === "string") &&
    validFeatures(input.features) &&
    Array.isArray(input.sources) &&
    input.sources.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string",
    )
  );
}

/** Bootstrap-only input for the split sanitized self-rebuild: emit an
 * executable from a serialized IR artifact of the same entry instead of
 * running the frontend. A separate run compares that artifact with the IR the
 * native frontend lowers itself. Debug metadata needs source text, so only
 * stripped executables are accepted. */
const BOOTSTRAP_IR_INPUT = "SCRIPTC_BOOTSTRAP_IR_INPUT";

function preparedFromIr(
  path: string,
  entry: string,
  options: CompileRequestOptions,
): { ok: true; mod: IrModule; sourceTexts: Map<string, string>; warnings: ScrDiagnostic[] } {
  if ((options.outputKind ?? "exe") !== "exe" || options.strip !== true)
    throw new Error(`${BOOTSTRAP_IR_INPUT} requires a stripped executable build`);
  const mod = deserializeModuleBytes(readFileSync(path));
  if (resolve(mod.sourceFile) !== resolve(entry))
    throw new Error(`${BOOTSTRAP_IR_INPUT} was lowered from a different entry`);
  return { ok: true, mod, sourceTexts: new Map(), warnings: [] };
}

/** Keep the checker and typed IR out of the native optimizer's live heap. */
export function prepareNativeExecutable(
  entry: string,
  options: CompileRequestOptions,
  ffi: FfiProfile | null,
  toolchain: NativeToolchain,
  frontend: FrontendFactory,
  cache: NativeCache | null,
  timing: CompilationTiming = () => {},
): NativeExecutableInput | CompileFailure {
  const outputKind = options.outputKind ?? "exe";
  const targetCpuRefusal = targetCpuTargetRefusal(
    options.targetCpu,
    toolchain.target.platform,
    toolchain.target.architecture,
  );
  if (targetCpuRefusal !== null)
    return {
      ok: false,
      diagnostics: [nativeCodegenDiag("SC3002", targetCpuRefusal, entry)],
      sourceTexts: new Map(),
    };
  const stem = basename(entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const outputPaths = [
    resolve(options.outPath),
    resolve(options.outPath) + ".dSYM",
    resolve(options.outDir, stem + ".ll"),
    resolve(options.outDir, stem + ".ir.json"),
  ];
  const directories = new Set<string>();
  for (const output of outputPaths) {
    for (let directory = dirname(output); ; directory = dirname(directory)) {
      directories.add(directory);
      if (dirname(directory) === directory) break;
    }
  }
  const exclusions = { outputPaths, outputDirectories: [...directories] };
  const irInput = process.env[BOOTSTRAP_IR_INPUT] ?? "";
  let key: string | null = null;
  if (cache !== null && irInput === "" && provenanceSources() === null) {
    try {
      key = contentDigest(
        JSON.stringify({
          schema: 1,
          entry,
          options,
          ffi,
          implementation: implementationIdentity(toolchain),
          target: toolchain.target.name,
          declarations: toolchain.declarationsRoot ?? null,
          environment: Object.entries(process.env)
            .filter(([name]) => name.startsWith("SCRIPTC_"))
            .sort(([a], [b]) => a.localeCompare(b)),
        }),
      );
      const cached = readFrontendCache(cache, key, exclusions);
      if (cached !== null && "input" in cached) {
        timing("frontend-cache-hit");
        return cached.input;
      }
      const equivalent =
        cached === null || outputKind === "ir"
          ? null
          : equivalentFrontendInput(cached.stale, options, exclusions);
      if (equivalent !== null) {
        publishFrontendCache(cache, key, equivalent.probes, equivalent.input);
        timing("frontend-cache-equivalent");
        return equivalent.input;
      }
    } catch {
      key = null;
    }
  }
  timing("frontend-cache-miss");
  const tracker = new FrontendInputTracker();
  const prepared =
    irInput !== ""
      ? preparedFromIr(irInput, entry, options)
      : tracker.runSynchronous(() =>
          prepareExecutableModule(entry, options, ffi, toolchain.target.platform, frontend, timing),
        );
  if (!prepared.ok) return prepared;
  if (irInput !== "") timing("ir-input");
  const ir =
    outputKind === "ir" || options.emitIr
      ? batchTextParts(serializeModuleParts(prepared.mod, compilerOwnedFileRoots()))
      : null;
  timing("ir-serialize");
  const llvm =
    outputKind === "ir"
      ? []
      : emitLlvmModuleParts(prepared.mod, {
          targetTriple: toolchain.target.llvmTriple,
          pointerBits: toolchain.target.pointerBits,
          wasi: toolchain.target.platform === "wasi",
          runtimeAbiMarker: outputKind === "obj" || outputKind === "exe",
          unwindAbi: outputKind === "exe" && toolchain.target.platform === "linux",
          objectAudit: options.sanitize === true,
          lowRegion: lowRegionTarget(toolchain.target.platform, options.sanitize === true),
          functionWorkers: emitWorkers(),
          forkPrimitives: emitForkPrimitives(),
          ...inlineRcOption(options.optimization, options.sanitize === true),
          ...(options.detachedExit === true && outputKind === "exe" ? { detachedExit: true } : {}),
          ...targetCpuField(options.targetCpu),
          ...(options.optimization === "dev" && !options.strip
            ? { debugSources: prepared.sourceTexts }
            : {}),
        });
  timing("llvm-emit");
  const input: NativeExecutableInput = {
    ok: true,
    llvm,
    ir,
    sidecarJson: null,
    features: executableLinkFeatures(prepared.mod),
    sources: [...prepared.sourceTexts],
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
  };
  timing("link-features");
  const probes = tracker.snapshot();
  if (
    cache !== null &&
    key !== null &&
    probes.stable &&
    frontendInputsStillMatch(probes, exclusions)
  ) {
    publishFrontendCache(cache, key, probes, input);
  }
  timing("frontend-cache-publish");
  return input;
}

/** Library preparation also ends before the native optimizer starts. The
 * cached form contains emitted artifacts, source frames, and the sidecar. */
export function prepareNativeLibrary(
  profile: LibraryProfile,
  options: CompileLibraryOptions,
  archivePath: string,
  toolchain: NativeToolchain,
  frontend: FrontendFactory,
  cache: NativeCache | null,
  timing: CompilationTiming = () => {},
): NativeExecutableInput | CompileFailure {
  const stem = basename(profile.entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const outputPaths = [
    archivePath,
    resolve(options.outDir, stem + ".lib.ll"),
    resolve(options.outDir, stem + ".lib.ir.json"),
  ];
  if (profile.sidecar !== null)
    outputPaths.push(
      profile.sidecar.path === null
        ? archivePath + ".contract.json"
        : resolve(dirname(archivePath), profile.sidecar.path),
    );
  const directories = new Set<string>();
  for (const output of outputPaths) {
    for (let directory = dirname(output); ; directory = dirname(directory)) {
      directories.add(directory);
      if (dirname(directory) === directory) break;
    }
  }
  const exclusions: FrontendInputExclusions = { outputPaths, outputDirectories: [...directories] };
  let key: string | null = null;
  if (cache !== null && provenanceSources() === null) {
    try {
      key = contentDigest(
        JSON.stringify({
          schema: 1,
          kind: "library",
          entry: profile.entry,
          profile: profile.profileBytes,
          options,
          implementation: implementationIdentity(toolchain),
          target: toolchain.target.name,
          declarations: toolchain.declarationsRoot ?? null,
          environment: Object.entries(process.env)
            .filter(([name]) => name.startsWith("SCRIPTC_"))
            .sort(([a], [b]) => a.localeCompare(b)),
        }),
      );
      const cached = readFrontendCache(cache, key, exclusions);
      if (cached !== null && "input" in cached) {
        timing("frontend-cache-hit");
        return cached.input;
      }
    } catch {
      key = null;
    }
  }
  timing("frontend-cache-miss");
  const tracker = new FrontendInputTracker();
  const prepared = tracker.runSynchronous(() => {
    for (let directory = dirname(profile.entry); ; directory = dirname(directory)) {
      trackedReadFile(join(directory, "tsconfig.json"));
      trackedReadFile(join(directory, "package.json"));
      if (directory === dirname(resolve(options.profilePath)) || dirname(directory) === directory)
        break;
    }
    return prepareLibrary(
      profile,
      options.profilePath,
      toolchain.compilerVersion,
      toolchain.target.platform,
      frontend,
      timing,
    );
  });
  if (!prepared.ok) return prepared;
  const llvm = emitLlvmModuleParts(prepared.mod, {
    targetTriple: toolchain.target.llvmTriple,
    pointerBits: toolchain.target.pointerBits,
    wasi: toolchain.target.platform === "wasi",
    objectAudit: options.sanitize === true,
    ...inlineRcOption(profile.optimization, options.sanitize === true),
  });
  timing("llvm-emit");
  const input: NativeExecutableInput = {
    ok: true,
    llvm,
    ir: options.emitIr
      ? batchTextParts(serializeModuleParts(prepared.mod, compilerOwnedFileRoots()))
      : null,
    sidecarJson: prepared.sidecarJson,
    features: executableLinkFeatures(prepared.mod),
    sources: [...prepared.sourceTexts],
  };
  timing("link-features");
  const probes = tracker.snapshot();
  if (
    cache !== null &&
    key !== null &&
    probes.stable &&
    frontendInputsStillMatch(probes, exclusions)
  ) {
    publishFrontendCache(cache, key, probes, input);
  }
  timing("frontend-cache-publish");
  return input;
}

/** Worker processes that emit function bodies at a time
 * (SCRIPTC_EMIT_WORKERS; 0 or 1 emits in this process). */
function emitWorkers(): number {
  const value = Number(process.env["SCRIPTC_EMIT_WORKERS"] ?? "4");
  return Number.isFinite(value) && value > 1 ? Math.floor(value) : 1;
}

/** The process primitives emission workers fork with, unless the host
 * cannot fork or this process is a worker itself. */
function emitForkPrimitives(): ForkPrimitives | undefined {
  const primitives = processFork.primitives;
  if (primitives === null || processFork.worker) return undefined;
  return {
    fork: () => primitives.fork(),
    exit: (code) => primitives.exit(code),
    wait: (pid) => primitives.wait(pid),
  };
}
