import { targetCpuField, targetCpuTargetRefusal } from "../backend/target-cpu.js";
import { nativeCodegenDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { CompilationTiming } from "../timing.js";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
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
import { REQUIRED_LINK_FEATURES } from "../backend/native-link-info-core.js";
import type { NativeLinkFeatures } from "../backend/native-link-info-core.js";
import { finishNodeIslands } from "../executable/islands.js";
import {
  loweringOptions,
  prepareLoweredProgram,
  usesLoweredProgram,
} from "../executable/lowered.js";
import { prepareExecutableModule } from "../executable/prepare.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import {
  FrontendInputTracker,
  changedFrontendInput,
  frontendInputsSemanticallyMatch,
  frontendInputsStillMatch,
  validFrontendInputSnapshot,
  type FrontendInputSnapshot,
  type FrontendInputExclusions,
  trackedReadFile,
} from "../frontend/input-tracker.js";
import { compilerOwnedFileRoots } from "../frontend/dts-paths.js";
import { frontendEnvironment } from "../frontend/environment.js";
import { provenanceSources } from "../frontend/provenance-registry.js";
import { processFork } from "../frontend/process-fork.js";
import { unitReuseEnabled, type UnitStore } from "../frontend/lowering/unit-reuse.js";
import {
  sourceEditDifference,
  tokenEquivalentSource,
  tokenPositionEquivalentSource,
} from "../frontend/token-equivalence.js";
import { llvmBytes, wtf8Bytes } from "../backend/literals.js";
import { prepareLibrary } from "../library/prepare.js";
import { libnodeCacheKeyFor } from "../node-islands/libnode.js";
import type { LibraryProfile } from "../library/library-profile.js";
import { serializeModuleParts } from "../ir/serialize.js";
import { contentDigest, NATIVE_STRING_BYTES, type NativeCache } from "./cache.js";
import { batchTextParts, joinedParts } from "./text-file.js";
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
  /** partsDigest of `llvm`, when the frontend cache has computed it: the key
   * of the text's `frontend-llvm` entry. */
  llvmDigest?: string;
  /** The Node islands the build ran (PreparedExecutableModule.islands). */
  islands?: { packages: string[]; modules: string[] };
  /** For a program that calls into Node (`features.nodeIsland`): the
   * identity of the libnode pack its executable records (libnodeCacheKey),
   * "" when no pack is named or installed. A cached input is this build's
   * only while the identity is unchanged. */
  libnode?: string;
}

/** The LLVM text is a separate `frontend-llvm` entry under its digest, which
 * `llvm` names, so a build whose inputs changed reads only this entry's
 * probes, and the text is hashed once per build. The serialized IR follows
 * the input metadata as a separate member so the entry can be written as
 * parts; the stored input carries empty placeholders (`[]`, `null`) for both. */
interface FrontendCacheEntry {
  schema: "scriptc.native-frontend.v4";
  probes: FrontendInputSnapshot;
  input: NativeExecutableInput;
  llvm: string;
  ir: string[] | null;
}

/** The entry's JSON text, generated as it is written. */
function* frontendCacheParts(
  probes: FrontendInputSnapshot,
  input: NativeExecutableInput,
  llvmDigest: string,
): Generator<string> {
  const metadata = JSON.stringify({
    schema: "scriptc.native-frontend.v4",
    probes,
    input: { ...input, llvm: [], ir: null, llvmDigest: undefined },
    llvm: llvmDigest,
  });
  yield metadata.slice(0, metadata.length - 1);
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

/** Publish an entry, and the LLVM text's entry unless `input` already names
 * one, only when a native reader can decode each as one string; UTF-16
 * length never exceeds the UTF-8 byte length. A longer entry abandons its
 * write, which the cache discards. Sets `input.llvmDigest` when the text's
 * entry is written. */
function publishFrontendCache(
  cache: NativeCache,
  key: string,
  probes: FrontendInputSnapshot,
  input: NativeExecutableInput,
): void {
  const llvmDigest =
    input.llvmDigest ??
    cache.writeContentParts(
      "frontend-llvm",
      boundedParts(joinedParts(input.llvm), NATIVE_STRING_BYTES),
    );
  if (llvmDigest === null) return;
  input.llvmDigest = llvmDigest;
  cache.writeParts(
    "frontend",
    key,
    boundedParts(frontendCacheParts(probes, input, llvmDigest), NATIVE_STRING_BYTES),
  );
}

/** The LLVM text of an entry, from its `frontend-llvm` entry; null when
 * that entry is missing or does not have the digest it is named by. */
function readFrontendLlvm(cache: NativeCache, digest: string): string | null {
  return cache.readContent("frontend-llvm", digest, NATIVE_STRING_BYTES)?.toString("utf8") ?? null;
}

/** The cached input when every frontend input still matches, else the
 * entry the inputs no longer match, for reuse after equivalent edits. */
function readFrontendCache(
  cache: NativeCache,
  key: string,
  exclusions: FrontendInputExclusions,
):
  | { input: NativeExecutableInput; probes: FrontendInputSnapshot }
  | { stale: FrontendCacheEntry }
  | null {
  // The entry is decoded as one string; larger entries are misses.
  const bytes = cache.read("frontend", key, NATIVE_STRING_BYTES);
  if (bytes === null) return null;
  const cached: unknown = JSON.parse(bytes.toString("utf8"));
  if (!validCachedInput(cached)) return null;
  if (!frontendInputsStillMatch(cached.probes, exclusions)) return { stale: cached };
  const llvm = readFrontendLlvm(cache, cached.llvm);
  if (llvm === null) return null;
  return {
    input: { ...cached.input, llvm: [llvm], llvmDigest: cached.llvm, ir: cached.ir },
    probes: cached.probes,
  };
}

/** The stale entry's input when every changed source is token-equivalent to
 * the text the entry was built from (edits to whitespace and to comments
 * that cannot affect compilation; see token-equivalence.ts). Equivalent
 * sources lower to the same IR apart from source locations, which only the
 * debug information of dev builds and the serialized IR carry. A build
 * with debug information accepts only edits that keep every token's line
 * and column, the positions the debug information records. Diagnostics
 * carry locations too: a warning that names a changed source would point
 * at its old text, so such an edit is rebuilt, while warnings about other
 * files stand as they are. The
 * frontend also reads raw text beside the tokens (call-site text in
 * messages, comptime callbacks, test locations, whole-file scans); the
 * entry's `text` probes record what it read of each source, and a changed
 * source is rebuilt unless every such read has the same answer over the new
 * text (token-equivalence.ts). A source whose whole text was read is always
 * rebuilt. When the entry cannot be reused, the result says why. */
function equivalentFrontendInput(
  cache: NativeCache,
  stale: FrontendCacheEntry,
  options: CompileRequestOptions,
  exclusions: FrontendInputExclusions,
): { input: NativeExecutableInput; probes: FrontendInputSnapshot } | { reason: string | null } {
  if (options.sanitize === true) return { reason: "a sanitized build runs the frontend" };
  if (options.emitIr === true || stale.ir !== null)
    return { reason: "the serialized IR carries source positions" };
  // An island program's LLVM text carries the bytes of its island modules
  // and the probe's snapshots, which no token comparison of sources covers.
  if (stale.input.features.nodeIsland === true)
    return { reason: "the output carries the program's Node island modules" };
  const debugInfo = options.optimization === "dev" && !options.strip;
  const previousSources = new Map(stale.input.sources);
  let reason: string | null = null;
  const match = frontendInputsSemanticallyMatch(
    stale.probes,
    previousSources,
    debugInfo ? tokenPositionEquivalentSource : tokenEquivalentSource,
    exclusions,
    (path, why) => {
      reason =
        why === "unread"
          ? `${path}: the build did not read it from the file`
          : why === "rewritten"
            ? `${path}: the build compiled a rewritten form of it`
            : `${path}: ${editDifference(stale, path, previousSources, debugInfo)}`;
    },
  );
  // With no reason, an input other than a program source changed.
  if (match === null) return { reason };
  if (match.changed.length === 0) return { reason: null };
  // A warning's location is offsets into its file, and its text can name a
  // file with them. Every path a warning holds is spelled in its JSON.
  const warnings = JSON.stringify(stale.input.warnings ?? []);
  const warned = match.changed.find(({ path }) =>
    warnings.includes(JSON.stringify(path).slice(1, -1)),
  );
  if (warned !== undefined)
    return { reason: `${warned.path}: the cached build reported a warning that names it` };
  const llvm = readFrontendLlvm(cache, stale.llvm);
  if (llvm === null) return { reason: null };
  // Runtime fences and unsupported-construct messages name their source as
  // `[<code> at <file>:<line>]`, and an equivalent edit can move the line.
  const named = match.changed.find(({ path }) =>
    llvm.includes(` at ${llvmBytes(wtf8Bytes(path), false)}:`),
  );
  if (named !== undefined) return { reason: `${named.path}: the output names a source line in it` };
  return {
    input: {
      ...stale.input,
      llvm: [llvm],
      llvmDigest: stale.llvm,
      ir: null,
      sources: stale.input.sources.map(([path, text]) => [
        path,
        match.currentSources.get(path) ?? text,
      ]),
    },
    probes: match.snapshot,
  };
}

/** Why the edit of `path` is not equivalent to the source `stale` was built
 * from, for the build's timing line. */
function editDifference(
  stale: FrontendCacheEntry,
  path: string,
  previousSources: ReadonlyMap<string, string>,
  debugInfo: boolean,
): string {
  const probe = stale.probes.probes.find((entry) => entry.op === "text" && entry.path === path);
  if (probe !== undefined && probe.op === "text" && probe.reads === undefined)
    return "the frontend read its whole text";
  try {
    return (
      sourceEditDifference(
        path,
        previousSources.get(path) ?? "",
        readFileSync(path, "utf8"),
        debugInfo,
        probe !== undefined && probe.op === "text" ? probe.reads : undefined,
      ) ?? "it changed again while it was compared"
    );
  } catch {
    return "it cannot be read";
  }
}

/** The unit store of a build whose unit key is `key`: its program entry
 * under that key, and file entries by content digest. */
function nativeUnitStore(cache: NativeCache, key: string): UnitStore {
  return {
    readProgram: () => cache.read("units", key),
    writeProgram: (bytes) => cache.write("units", key, bytes),
    readFile: (name) => (/^[0-9a-f]{64}$/.test(name) ? cache.read("unit-files", name) : null),
    writeFile: (bytes) => {
      const digest = contentDigest(bytes);
      if (!cache.has("unit-files", digest)) cache.write("unit-files", digest, bytes, digest);
      return digest;
    },
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
  return REQUIRED_LINK_FEATURES.every((name) => typeof features[name] === "boolean");
}

function validCachedInput(value: unknown): value is FrontendCacheEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<FrontendCacheEntry>;
  const input = entry.input;
  if (
    entry.schema !== "scriptc.native-frontend.v4" ||
    !validFrontendInputSnapshot(entry.probes) ||
    input === undefined ||
    input === null ||
    typeof input !== "object"
  )
    return false;
  return (
    input.ok === true &&
    typeof entry.llvm === "string" &&
    /^[0-9a-f]{64}$/.test(entry.llvm) &&
    (entry.ir === null ||
      (Array.isArray(entry.ir) && entry.ir.every((part) => typeof part === "string"))) &&
    (input.sidecarJson === null || typeof input.sidecarJson === "string") &&
    validFeatures(input.features) &&
    (input.libnode === undefined || typeof input.libnode === "string") &&
    (input.islands === undefined ||
      (Array.isArray(input.islands.packages) && Array.isArray(input.islands.modules))) &&
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

/** The inputs a native frontend cache entry depends on: the entry, the
 * request's options and FFI manifest, the toolchain that lowers and emits,
 * and the SCRIPTC_* variables that reach the frontend. The sources and the
 * configuration are not part of it; the entry's probes prove those. Null when
 * an entry cannot describe the build: provenance rewriting replaces the
 * sources with build products, and a build that writes or reads a lowered
 * program (executable/lowered.ts) runs its frontend, or none, whatever an
 * entry holds. */
function nativeFrontendInputs(
  entry: string,
  options: CompileRequestOptions,
  ffi: FfiProfile | null,
  toolchain: NativeToolchain,
): Record<string, unknown> | null {
  if (usesLoweredProgram(options) || provenanceSources() !== null) return null;
  return {
    schema: 1,
    entry,
    options,
    ffi,
    implementation: implementationIdentity(toolchain),
    target: toolchain.target.name,
    declarations: toolchain.declarationsRoot ?? null,
    environment: frontendEnvironment(),
  };
}

/** The frontend cache key of a build: digest of nativeFrontendInputs. Null
 * when the build cannot have an entry (see nativeFrontendInputs) or the
 * inputs cannot be encoded. */
export function nativeFrontendCacheKey(
  entry: string,
  options: CompileRequestOptions,
  ffi: FfiProfile | null,
  toolchain: NativeToolchain,
): string | null {
  try {
    const inputs = nativeFrontendInputs(entry, options, ffi, toolchain);
    return inputs === null ? null : contentDigest(JSON.stringify(inputs));
  } catch {
    return null;
  }
}

/** The paths a native executable build writes — the executable, its dSYM
 * directory, the kept LLVM text and IR — and the directories above them,
 * which its frontend input probes do not observe. */
export function nativeFrontendExclusions(
  entry: string,
  options: CompileRequestOptions,
): FrontendInputExclusions {
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
  return { outputPaths, outputDirectories: [...directories] };
}

/** The identity of the libnode pack a build of `entry` records, as a
 * cached input stores it. */
function libnodeIdentity(
  entry: string,
  options: CompileRequestOptions,
  toolchain: NativeToolchain,
): string {
  return (
    libnodeCacheKeyFor(toolchain.target.name, options.libnode, process.env, dirname(entry)) ?? ""
  );
}

/** Whether a cached input can stand for this build as far as its islands
 * go. A program without islands always can. One that calls into Node
 * recorded a libnode pack, which must still be the one this build would
 * record; and `--libnode=beside` places the pack and the island modules
 * next to the output from the lowered module, which a cached input does
 * not have, so such a build always lowers. */
function islandInputCurrent(
  input: NativeExecutableInput,
  entry: string,
  options: CompileRequestOptions,
  toolchain: NativeToolchain,
): boolean {
  if (input.features.nodeIsland !== true) return true;
  if (options.libnode === "beside") return false;
  return input.libnode === libnodeIdentity(entry, options, toolchain);
}

/** Why a frontend result with these input observations must not enter the
 * cache, or null when it may: the observations are incomplete or changed
 * while the frontend ran (the snapshot is not stable), or an input no
 * longer has the answer the frontend saw. The words go on the build's
 * timing line, since a build that is never cached is otherwise silent. */
function unpublishable(
  probes: FrontendInputSnapshot,
  exclusions: FrontendInputExclusions,
): string | null {
  if (!probes.stable) return probes.unstable ?? "an input changed while the frontend ran";
  const changed = changedFrontendInput(probes, exclusions);
  return changed === null ? null : `${changed.path} changed during the build (${changed.op})`;
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
  /** The input observations this build's output depends on, when they are
   * stable and match the inputs (the condition under which the frontend
   * cache entry is published): the unchanged-build record stores them. */
  onInputs?: (probes: FrontendInputSnapshot) => void,
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
  const exclusions = nativeFrontendExclusions(entry, options);
  let key: string | null = null;
  // Why this build has no cache key, for its timing line: an entry cannot
  // describe it (nativeFrontendInputs), or something could not be read.
  let keyless =
    "the build has no cache entry: it writes or reads a lowered program, or rewrites its sources for provenance";
  // The unit store's key (unit-reuse.ts): the frontend's inputs without the
  // output paths, which lowering does not read.
  let unitKey: string | null = null;
  // The entry this build replaces: its probes give the digests of unchanged files.
  let previous: FrontendInputSnapshot | undefined;
  let missReason: string | null = null;
  // A toolchain input that cannot be read leaves the build to its cache misses.
  let inputs: Record<string, unknown> | null = null;
  try {
    inputs = nativeFrontendInputs(entry, options, ffi, toolchain);
  } catch {
    inputs = null;
    keyless = "the compiler's toolchain could not be identified";
  }
  if (cache !== null && inputs !== null) {
    try {
      key = contentDigest(JSON.stringify(inputs));
      if (unitReuseEnabled()) {
        unitKey = contentDigest(JSON.stringify({ ...inputs, options: loweringOptions(options) }));
      }
      const read = readFrontendCache(cache, key, exclusions);
      const cached =
        read !== null &&
        !islandInputCurrent(
          "input" in read ? read.input : read.stale.input,
          entry,
          options,
          toolchain,
        )
          ? null
          : read;
      if (cached !== null && "input" in cached) {
        onInputs?.(cached.probes);
        timing("frontend-cache-hit");
        return cached.input;
      }
      if (cached !== null) previous = cached.stale.probes;
      const equivalent =
        cached === null || outputKind === "ir"
          ? null
          : equivalentFrontendInput(cache, cached.stale, options, exclusions);
      if (equivalent !== null && "input" in equivalent) {
        publishFrontendCache(cache, key, equivalent.probes, equivalent.input);
        onInputs?.(equivalent.probes);
        timing("frontend-cache-equivalent");
        return equivalent.input;
      }
      missReason = equivalent?.reason ?? null;
    } catch {
      key = null;
      keyless = "the frontend cache could not be read";
    }
  }
  // Why an edit that keeps the tokens still runs the frontend.
  timing("frontend-cache-miss", missReason === null ? undefined : { reason: missReason });
  const tracker = new FrontendInputTracker(previous);
  // The island steps (executable/islands.ts) follow lowering inside the
  // tracker, so the project configuration they read is an input too.
  const lowered = tracker.runSynchronous(() => {
    const prepared = prepareLoweredProgram(
      entry,
      options,
      toolchain.target.platform,
      timing,
      {
        compiler: () => implementationIdentity(toolchain),
        outputs: exclusions.outputPaths ?? [],
      },
      () =>
        prepareExecutableModule(
          entry,
          options,
          ffi,
          toolchain.target.platform,
          frontend,
          timing,
          new Map(),
          true,
          cache !== null && unitKey !== null ? nativeUnitStore(cache, unitKey) : null,
        ),
    );
    if (!prepared.ok) return { prepared, islandModuleData: undefined };
    const islands = finishNodeIslands(prepared.mod, entry, {
      outputKind,
      outPath: options.outPath,
      libnode: options.libnode,
      target: () => toolchain.target.name,
    });
    if (!islands.ok) {
      const failed: CompileFailure = {
        ok: false,
        diagnostics: [islands.diagnostic],
        sourceTexts: prepared.sourceTexts,
      };
      return { prepared: failed, islandModuleData: undefined };
    }
    return { prepared, islandModuleData: islands.moduleData };
  });
  const { prepared, islandModuleData } = lowered;
  if (!prepared.ok) return prepared;
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
          // As for the Node-hosted build: executables and their textual
          // LLVM and assembly, not objects.
          unwindAbi:
            (outputKind === "exe" || outputKind === "llvm" || outputKind === "asm") &&
            toolchain.target.platform === "linux",
          objectAudit: options.sanitize === true,
          sanitizeAttributes: options.sanitize === true,
          lowRegion: lowRegionTarget(toolchain.target.platform, options.sanitize === true),
          functionWorkers: emitWorkers(),
          forkPrimitives: emitForkPrimitives(),
          timing,
          ...inlineRcOption(options.optimization, options.sanitize === true),
          ...(options.detachedExit === true && outputKind === "exe" ? { detachedExit: true } : {}),
          ...(options.stdoutBuffering === true && outputKind === "exe"
            ? { stdoutBuffering: true }
            : {}),
          ...(options.exceptions === "rare" ? { rareExceptions: true } : {}),
          ...targetCpuField(options.targetCpu),
          ...(options.cpuDispatch === true && outputKind === "exe" ? { cpuDispatch: true } : {}),
          ...(options.optimization === "dev" && !options.strip
            ? { debugSources: prepared.sourceTexts }
            : {}),
          ...(islandModuleData === undefined ? {} : { nodeIslandModuleData: islandModuleData }),
        });
  timing("llvm-emit");
  const features = executableLinkFeatures(
    prepared.mod,
    options.largePages === true && outputKind === "exe",
  );
  const input: NativeExecutableInput = {
    ok: true,
    llvm,
    ir,
    sidecarJson: null,
    features,
    sources: [...prepared.sourceTexts],
    ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}),
    ...(prepared.islands === undefined ? {} : { islands: prepared.islands }),
    ...(features.nodeIsland === true
      ? { libnode: libnodeIdentity(entry, options, toolchain) }
      : {}),
  };
  timing("link-features");
  const probes = tracker.snapshot();
  const unpublished =
    cache === null
      ? null
      : key === null
        ? keyless
        : (unpublishable(probes, exclusions) ??
          (islandInputCurrent(input, entry, options, toolchain)
            ? null
            : options.libnode === "beside"
              ? "a --libnode=beside build places the pack and the island modules from the lowered module"
              : "the libnode pack changed during the build"));
  if (cache !== null && key !== null && unpublished === null) {
    publishFrontendCache(cache, key, probes, input);
    onInputs?.(probes);
  }
  timing("frontend-cache-publish", unpublished === null ? undefined : { skipped: unpublished });
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
          environment: frontendEnvironment(),
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
    sanitizeAttributes: options.sanitize === true,
    timing,
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
  const unpublished = cache === null || key === null ? null : unpublishable(probes, exclusions);
  if (cache !== null && key !== null && unpublished === null)
    publishFrontendCache(cache, key, probes, input);
  timing("frontend-cache-publish", unpublished === null ? undefined : { skipped: unpublished });
  return input;
}

/** Worker processes that emit function bodies at a time: up to eight, one
 * per available core (SCRIPTC_EMIT_WORKERS sets the count; 0 or 1 emits in
 * this process). */
function emitWorkers(): number {
  const configured = process.env["SCRIPTC_EMIT_WORKERS"];
  const value = configured === undefined ? Math.min(8, availableParallelism()) : Number(configured);
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
    exited: () => primitives.exited(),
  };
}
