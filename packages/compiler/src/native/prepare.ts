import type { CompilationTiming } from "../timing.js";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CompileFailure,
  CompileLibraryOptions,
  CompileRequestOptions,
} from "../compile-types.js";
import { emitLlvmModule } from "../backend/llvm/emitter.js";
import { executableLinkFeatures } from "../backend/executable-features.js";
import type { NativeLinkFeatures } from "../backend/native-link-info-core.js";
import { prepareExecutableModule } from "../executable/prepare.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import {
  FrontendInputTracker,
  frontendInputsStillMatch,
  validFrontendInputSnapshot,
  type FrontendInputSnapshot,
  type FrontendInputExclusions,
  trackedReadFile,
} from "../frontend/input-tracker.js";
import { provenanceSources } from "../frontend/provenance-registry.js";
import { prepareLibrary } from "../library/prepare.js";
import type { LibraryProfile } from "../library/library-profile.js";
import type { IrModule } from "../ir/ir.js";
import { deserializeModule, serializeModule } from "../ir/serialize.js";
import { contentDigest, type NativeCache } from "./cache.js";
import type { NativeToolchain } from "./toolchain.js";
import { nativeFileIdentity } from "./file-identity.js";

export interface NativeExecutableInput {
  ok: true;
  llvm: string;
  ir: string | null;
  sidecarJson: string | null;
  features: NativeLinkFeatures;
  sources: [string, string][];
}

interface FrontendCacheEntry {
  schema: "scriptc.native-frontend.v2";
  probes: FrontendInputSnapshot;
  input: NativeExecutableInput;
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
  return [
    "dynamic",
    "regex",
    "copying",
    "textDecoderLegacy",
    "fileHandle",
    "fetch",
    "netIsland",
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
    "parseArgs",
    "stream",
    "net",
    "http",
    "http2",
    "dgram",
    "watch",
    "foreignFfi",
    "nodeTest",
    "tls",
    "tlsCa",
  ].every((name) => typeof features[name] === "boolean");
}

function validCachedInput(value: unknown): value is FrontendCacheEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<FrontendCacheEntry>;
  const input = entry.input;
  if (
    entry.schema !== "scriptc.native-frontend.v2" ||
    !validFrontendInputSnapshot(entry.probes) ||
    input === undefined ||
    input === null ||
    typeof input !== "object"
  )
    return false;
  return (
    input.ok === true &&
    typeof input.llvm === "string" &&
    (input.ir === null || typeof input.ir === "string") &&
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
): { ok: true; mod: IrModule; sourceTexts: Map<string, string> } {
  if ((options.outputKind ?? "exe") !== "exe" || options.strip !== true)
    throw new Error(`${BOOTSTRAP_IR_INPUT} requires a stripped executable build`);
  const mod = deserializeModule(readFileSync(path, "utf8"));
  if (resolve(mod.sourceFile) !== resolve(entry))
    throw new Error(`${BOOTSTRAP_IR_INPUT} was lowered from a different entry`);
  return { ok: true, mod, sourceTexts: new Map() };
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
      const bytes = cache.read("frontend", key);
      if (bytes !== null) {
        const cached: unknown = JSON.parse(bytes.toString("utf8"));
        if (validCachedInput(cached) && frontendInputsStillMatch(cached.probes, exclusions)) {
          const input: NativeExecutableInput = cached.input;
          timing("frontend-cache-hit");
          return input;
        }
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
  const ir = outputKind === "ir" || options.emitIr ? serializeModule(prepared.mod, true) : null;
  timing("ir-serialize");
  const llvm =
    outputKind === "ir"
      ? ""
      : emitLlvmModule(prepared.mod, {
          targetTriple: toolchain.target.llvmTriple,
          pointerBits: toolchain.target.pointerBits,
          wasi: toolchain.target.platform === "wasi",
          runtimeAbiMarker: outputKind === "obj" || outputKind === "exe",
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
    features: executableLinkFeatures(prepared.mod, options.dynamic ?? false),
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
    const saved: FrontendCacheEntry = { schema: "scriptc.native-frontend.v2", probes, input };
    cache.write("frontend", key, JSON.stringify(saved));
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
      const bytes = cache.read("frontend", key);
      if (bytes !== null) {
        const cached: unknown = JSON.parse(bytes.toString("utf8"));
        if (validCachedInput(cached) && frontendInputsStillMatch(cached.probes, exclusions)) {
          const input: NativeExecutableInput = cached.input;
          timing("frontend-cache-hit");
          return input;
        }
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
  const llvm = emitLlvmModule(prepared.mod, {
    targetTriple: toolchain.target.llvmTriple,
    pointerBits: toolchain.target.pointerBits,
    wasi: toolchain.target.platform === "wasi",
  });
  timing("llvm-emit");
  const input: NativeExecutableInput = {
    ok: true,
    llvm,
    ir: options.emitIr ? serializeModule(prepared.mod, true) : null,
    sidecarJson: prepared.sidecarJson,
    features: executableLinkFeatures(prepared.mod, false),
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
    const saved: FrontendCacheEntry = { schema: "scriptc.native-frontend.v2", probes, input };
    cache.write("frontend", key, JSON.stringify(saved));
  }
  timing("frontend-cache-publish");
  return input;
}
