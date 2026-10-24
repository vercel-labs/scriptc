import { optimizationField, type NativeOptimization } from "./backend/optimization.js";
import { targetCpuField, targetCpuTargetRefusal } from "./backend/target-cpu.js";
import { compilationTiming, type CompilationTiming, type TimingClock } from "./timing.js";
import { prepareExecutableModule } from "./executable/prepare.js";
import {
  prepareLibrary,
  libraryLocalizeSymbols,
  libraryWasmExports,
  libraryWasmRefusal,
} from "./library/prepare.js";
import { analyzeWithFrontend } from "./frontend/analysis.js";
import { checkerCacheIdentity } from "./frontend/ts7/checker-backend.js";
import { setLibDiagnosticsStore } from "./frontend/ts7/lib-diagnostics.js";
import { analyzeWithVerdictCache, fileVerdictStore } from "./coverage/verdict-cache.js";
import { coverageCompilerIdentity } from "./coverage/verdict-startup.js";
import { commentOnlyReplay } from "./coverage/verdict-semantic.js";
import { llvmRefusalDiag, targetRefusalDiag } from "./backend/target-diagnostics.js";
import type {
  CompileOptions,
  CompileSourceOptions,
  CompileRequestOptions,
  CompileSourceResult,
  CompileResult,
  CompileExecutableResult,
  CompileRequestResult,
  CompileLibraryOptions,
  CompileLibraryResult,
  AnalyzeOptions,
  AnalyzeResult,
} from "./compile-types.js";
export type {
  CompileOutputKind,
  CompileBaseOptions,
  CompileOptions,
  CompileSourceOptions,
  CompileRequestOptions,
  CompileArtifact,
  CompileFailure,
  CompileSourceResult,
  CompileResult,
  CompileExecutableResult,
  CompileRequestResult,
  CompileLibraryOptions,
  CompileLibraryResult,
  AnalyzeOptions,
  AnalyzeResult,
} from "./compile-types.js";
import { compilePackedLibrary } from "./backend/library-pack.js";
import { InternalCompilerError } from "./errors.js";
import { frontendProcessExecArgv } from "./frontend-process-args.js";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearCcCaches,
  configuredTargetPlatform,
  type NativeArtifactDependency,
} from "./backend/native-toolchain.js";
import { buildCacheRoot, prepareBuildCacheRoot, pruneBuildCache } from "./backend/build-cache.js";
import {
  CcCompileError,
  compileExternalC,
  compileExternalCLibrary,
  executableNativeEnvironmentFingerprint,
  mobileLibraryTarget,
  mobileTargetRefusal,
  resolveCc,
} from "./backend/external-c.js";
import {
  emitLlvmModuleSource,
  LlvmUnsupportedError,
  lowRegionTarget,
} from "./backend/llvm/emitter.js";
import { inlineRcOption } from "./backend/llvm/shapes.js";
import {
  emitNativeArtifact,
  isLlvmFile,
  llvmInputBytes,
  type LlvmInput,
  NativeCodegenError,
  writeLlvmSource,
} from "./backend/native-codegen.js";
import {
  nativeInlineThreshold,
  nativePartitionPaths,
  nativeProgramPartitions,
} from "./backend/native-codegen-core.js";
import { privateSiblingPath } from "./backend/build-cache.js";
import { nativeCodegenTarget, nativeCodegenTargetRefusal } from "./backend/targets.js";
import { windowsSubsystemLinkerArgs, type WindowsSubsystem } from "./backend/targets.js";
import { createNativeLinkInfo } from "./backend/native-link-info.js";
import { RuntimePackError } from "./backend/runtime-pack.js";
import { createNativeLinkPlan } from "./backend/link-plan.js";
import {
  nativeProfileKey,
  nativeProfileRefusal,
  type NativeProfileOptions,
} from "./backend/native-profile.js";
import {
  executableLinkerEnvironmentFingerprint,
  linkNativeExecutable,
  platformLinkerSupportsPersistentCache,
  resolvePlatformLinker,
} from "./backend/linker.js";
import { splitLlvmLibraryProgram, splitLlvmProgram } from "./backend/llvm/split.js";
import {
  emitLibraryIdentityLines,
  replaceLibraryIdentity,
  stripLibraryIdentity,
} from "./backend/library-identity-markers.js";
import {
  ffiNativeBuildDiag,
  iceDiag,
  nativeCodegenDiag,
  type ScrDiagnostic,
} from "./diagnostics/diagnostic.js";
import { loadLibraryProfile, type LibraryProfile } from "./library/library-profile.js";
import { clearFenceEvalCaches, decorateLibraryRefusals } from "./library/fence-eval.js";
import {
  canonicalModuleGraph,
  clearSidecarCaches,
  compilerReleaseVersion,
  libraryIdentityHashes,
  updateSidecarIdentity,
} from "./library/sidecar.js";
import { type IrModule, type SrcLoc } from "./ir/ir.js";
import { moduleRuntimeFeatures } from "./ir/runtime-features.js";
import { serializeModuleParts } from "./ir/serialize.js";
import { readTextParts, writeTextParts } from "./text-parts.js";
import { validateModule } from "./ir/validate.js";
import { compilerOwnedFileRoots } from "./frontend/dts-paths.js";
import { loadProgram } from "./frontend/program-node.js";
import { runFrontend, type FrontendFactory } from "./frontend/pipeline.js";
import {
  type ProvenanceSources,
  provenanceSources,
  setProvenanceSources,
} from "./frontend/provenance-registry.js";
import { clearResolveCaches } from "./frontend/resolve.js";
import { loadFfiProfile, type FfiProfile } from "./ffi/ffi-manifest.js";
import { executableLinkFeatures } from "./backend/executable-features.js";
import { youngNurseryRequested } from "./backend/young-nursery.js";
import {
  type FrontendInputSnapshot,
  FrontendInputTracker,
  trackedReadFile,
} from "./frontend/input-tracker.js";
import {
  libraryFrontendImplementationFingerprint,
  publishEarlyLibraryCache,
  readEarlyLibraryCache,
  readSemanticLibraryCache,
  type EarlyLibraryCacheOptions,
  type EarlyLibraryCachePublish,
  type EarlyLibraryNativeFeatures,
  type SemanticLibraryCacheHit,
} from "./library/library-cache.js";
import {
  hasEarlyExecutableNativeBuild,
  publishEarlyExecutableCache,
  publishEarlyExecutableRoute,
  readEarlyExecutableCache,
  recordEarlyExecutableNativeBuild,
  type EarlyExecutableCacheOptions,
  type EarlyExecutableNativeFeatures,
} from "./executable/executable-cache.js";
import { compilerImplementationIdentity } from "./library/compiler-self-identity.js";
import { isPerformanceCode } from "./diagnostics/dynamic-tier.js";

export const VERSION = "0.0.1";

export {
  EXTERNAL_OBJECT_ABI_STABILITY,
  RUNTIME_ABI_MARKER,
  RUNTIME_ABI_VERSION,
} from "./backend/runtime-abi.js";
export type { NativeLinkInfo, NativeLinkFeatures } from "./backend/native-link-info.js";
export type { WindowsSubsystem } from "./backend/targets.js";

export { InternalCompilerError } from "./errors.js";
export {
  compileExternalC as compileC,
  compileExternalC,
  runtimeSrcDir,
  type CcOptions,
  type NativeCacheWarmProfile,
  type WarmNativeCachesOptions,
  type WarmNativeCachesResult,
} from "./backend/external-c.js";
export { warmNativeCaches } from "./backend/warm-cache.js";
export { mergeNativeProfiles as mergeProfiles } from "./backend/native-codegen.js";
export { collectGarbageUnderHeapPressure } from "./heap-collection.js";
export {
  ANDROID_MIN_API,
  IPHONEOS_MIN_VERSION,
  isAndroidTarget,
  isIosTarget,
  isMobileTarget,
  mobileLibraryTarget,
  mobileTargetRefusal,
} from "./backend/external-c.js";
export { emitLlvmModule, type LlvmTargetOptions } from "./backend/llvm/emitter.js";
export type { ScrDiagnostic } from "./diagnostics/diagnostic.js";
export {
  renderDiagnostics,
  renderDiagnostics as renderAll,
  renderDiagnostic,
} from "./diagnostics/render.js";
export {
  renderCoverage,
  renderExplainDynamic,
  coverageEnvelope,
  coveragePasses,
  type CoverageInput,
  type CoverageFailOn,
} from "./coverage/report.js";
export {
  TIER_MODES,
  type DemotedUnit,
  type DemotionRequest,
  type DemotionSeed,
  type DemotionUnit,
  type DemotionUnitKind,
  type TierMode,
  type TierReport,
} from "./frontend/tier-analysis.js";
export {
  buildEnvelope,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticsEnvelope,
  type DiagnosticGroup,
  type LocatedDiagnostic,
  type DiagnosticCategory,
  type DiagnosticScope,
} from "./diagnostics/envelope.js";
export {
  generateSurfaceManifest,
  renderSurfaceManifest,
  MANIFEST_SCHEMA_VERSION,
  type SurfaceManifest,
  type SurfaceManifestEntry,
} from "./coverage/surface-manifest.js";
export {
  NODE24_FETCH_COMPAT_PROFILE,
  type FetchCompatEvidence,
  type FetchCompatFacet,
  type FetchCompatInventory,
  type FetchCompatInventoryEntry,
  type FetchCompatInventoryExclusion,
  type FetchCompatInventoryPlacement,
  type FetchCompatInventoryStatus,
  type FetchCompatOperation,
  type FetchCompatOption,
  type FetchCompatProfile,
} from "./compat/fetch-profile.js";
export { LIB_FN_SIGS } from "./ir/builtin-signatures.js";
export { validateModule } from "./ir/validate.js";
export {
  assignLegacyTiers,
  dynamicOperationOf,
  functionTier,
  type DynamicFunction,
  type IrTier,
} from "./ir/tiers.js";
export {
  deserializeModule,
  deserializeModuleBytes,
  IR_VERSION,
  serializeModule,
  serializeModuleParts,
} from "./ir/serialize.js";
export {
  resolveLibraryFences,
  type LibraryFenceDecl,
  type ResolvedLibraryFence,
} from "./library/fence-eval.js";
export {
  loadLibraryProfile,
  profileTeaching,
  profileRemediation,
  LIB_PARAM_CLASSES,
  LIB_RETURN_CLASSES,
  type LibraryProfile,
  type LibraryExportEntry,
  type LibrarySidecarConfig,
  type LibParamClass,
  type LibReturnClass,
} from "./library/library-profile.js";
export {
  loadFfiProfile,
  FFI_CALLBACK_PARAM_CLASSES,
  FFI_PARAM_CLASSES,
  FFI_RETURN_CLASSES,
  type FfiCallbackParam,
  type FfiCallbackParamClass,
  type FfiContextParam,
  type FfiFunction,
  type FfiParamClass,
  type FfiProfile,
  type FfiReturnClass,
  type FfiValueParamClass,
} from "./ffi/ffi-manifest.js";
export {
  assembleTrapTeaching,
  TRAP_TEACHING_MARKER,
  TRAP_TEACHING_SEP,
} from "./library/trap-teaching.js";
export {
  abiExportSuffixes,
  buildSidecar,
  canonicalModuleGraph,
  canonicalPath,
  compilerReleaseVersion,
  libraryIdentityHashes,
  SIDECAR_FORMAT,
  type SidecarDoc,
  type SidecarBuildInput,
  type SidecarBuildResult,
  type TypeRef,
  type PayloadDescriptor,
} from "./library/sidecar.js";
export { validateSidecar } from "./library/sidecar-validate.js";
export {
  BUILD_ID_SEED,
  SOURCE_HASH_SEED,
  hex16,
  lengthPrefixedStream,
  wyhash64,
} from "./library/wyhash.js";
export {
  STDLIB_SURFACE,
  STATIC_MATH_PROPS,
  type StdlibFnEntry,
} from "./frontend/lowering/surfaces.js";
export {
  ambientDtsPath,
  isExactExternalTypeSpecifier,
  overridesDtsPath,
} from "./frontend/program-node.js";
export { resolveProvenanceSources } from "./frontend/provenance.js";
export { wasiGuestPath, type HostPathFlavor } from "./wasi-paths.js";
export {
  setProvenanceSources,
  type ProvenancePackageSource,
  type ProvenanceSources,
} from "./frontend/provenance-registry.js";
export * as ir from "./ir/api.js";

/** Clang may print every warning from the generated/runtime translation
 * units before the actionable linker failure. Keep the source diagnostic
 * precise by starting at the first portable linker marker; if the driver
 * supplied no recognizable marker, retain only its bounded tail. */
function ffiNativeBuildDetail(err: CcCompileError): string {
  const lines = err.stderr.trim().split(/\r?\n/);
  const linkerMarker = lines.findIndex((line) =>
    /(?:Undefined symbols|undefined reference to|unresolved external symbol|duplicate symbol|library not found for|cannot find -l|unable to find library|file format not recognized|linker command failed|fatal error LNK|lld-link: error)/i.test(
      line,
    ),
  );
  const relevant = linkerMarker >= 0 ? lines.slice(linkerMarker) : lines.slice(-40);
  const output = relevant.join("\n").trim();
  return (
    `${err.driver} ${linkerMarker >= 0 ? "could not link the generated program" : "failed while building the generated program"}` +
    (output.length > 0 ? `:\n${output}` : "")
  );
}

/** Platform semantics depend on the output target, without compiler discovery. */
export function buildTargetPlatform(env: NodeJS.ProcessEnv = process.env): string {
  return configuredTargetPlatform(env);
}

/** Target-platform classification without compiler or SDK discovery. Source
 * artifacts need target semantics for lowering, but do not need a native
 * toolchain merely to decide whether that target is Windows, WASI, etc. */
export function sourceTargetPlatform(env: NodeJS.ProcessEnv = process.env): string {
  return configuredTargetPlatform(env);
}

export function analyze(entryPath: string, opts: AnalyzeOptions = {}): AnalyzeResult {
  return analyzeWithFrontend(entryPath, opts, buildTargetPlatform(), nodeFrontend);
}

/** analyze() behind the coverage verdict cache (the CLI's `scriptc
 * coverage`): an unchanged program, or one whose TypeScript edits only
 * touch comments, replays the previous verdict without lowering. */
export async function analyzeCached(
  entryPath: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  entryPath = resolve(entryPath);
  const root = await prepareBuildCacheRoot(buildCacheRoot());
  if (root === null || provenanceSources() !== null) return analyze(entryPath, opts);
  const directory = join(root, "coverage-v1");
  const implementation = await coverageCompilerIdentity(directory);
  if (implementation === null) return analyze(entryPath, opts);
  const { result, outcome } = analyzeWithVerdictCache(
    entryPath,
    opts,
    {
      store: fileVerdictStore(directory),
      identity: implementation.digest,
      platform: buildTargetPlatform(),
      semanticReplay: commentOnlyReplay,
    },
    () => analyze(entryPath, opts),
  );
  if (process.env["SCRIPTC_TIMING"] === "1") {
    process.stderr.write(`scriptc coverage cache ${JSON.stringify({ outcome })}\n`);
  }
  return result;
}

const nodeFrontend: FrontendFactory = (entry, npmStatic, externalTypes, libraryNpmStatic) =>
  runFrontend(entry, loadProgram, npmStatic, externalTypes, libraryNpmStatic);

/** The checker's part of the executable cache key (`checkerCacheIdentity`), as the CLI's startup route computes it. */
function checkerField(): { checker?: string } {
  const checker = checkerCacheIdentity();
  return checker === undefined ? {} : { checker };
}

/** The whole pipeline: load → preflight → lower → validate → emit LLVM → link. */
function clearCompileSessionCaches(): void {
  clearResolveCaches();
  clearCcCaches();
  clearSidecarCaches();
  clearFenceEvalCaches();
}

export function compile(
  entryPath: string,
  opts: CompileSourceOptions,
): Promise<CompileSourceResult>;
export function compile(entryPath: string, opts: CompileOptions): Promise<CompileExecutableResult>;
export function compile(
  entryPath: string,
  opts: CompileRequestOptions,
): Promise<CompileRequestResult>;
export async function compile(
  entryPath: string,
  opts: CompileRequestOptions,
): Promise<CompileRequestResult> {
  clearCompileSessionCaches();
  const frontendInputs = new FrontendInputTracker();
  const warnings: CompileWarningSink = { warnings: [], sourceTexts: null };
  // compileTracked starts it for a build with no earlier build of the same invocation.
  const frontendProcess = preparesInChildProcess(opts) ? new FrontendProcess() : undefined;
  try {
    const result = await frontendInputs.run(() =>
      compileTracked(entryPath, opts, frontendInputs, warnings, frontendProcess),
    );
    return withCompileWarnings(result, warnings);
  } finally {
    setLibDiagnosticsStore(null);
    frontendProcess?.release();
  }
}

/** Divergence warnings collected while a compile lowers (none when a cache
 * hit skips lowering). */
interface CompileWarningSink {
  warnings: ScrDiagnostic[];
  sourceTexts: Map<string, string> | null;
}

/** The build's performance warnings (SC61xx), stored with its cache entry
 * so a cache hit repeats them. */
function performanceWarnings(sink: CompileWarningSink | undefined): {
  performance?: ScrDiagnostic[];
} {
  const performance = (sink?.warnings ?? []).filter((d) => isPerformanceCode(d.code));
  return performance.length === 0 ? {} : { performance };
}

function withCompileWarnings<T extends CompileRequestResult>(
  result: T,
  sink: CompileWarningSink,
): T {
  if (!result.ok || sink.warnings.length === 0) return result;
  return { ...result, warnings: sink.warnings, sourceTexts: sink.sourceTexts ?? new Map() };
}

/** Build-time API compatibility fence: a caller's existing CompileOptions
 * variable must retain the executable result aliases without narrowing. */
async function assertCompileOptionsCompatibility(
  entryPath: string,
  opts: CompileOptions,
): Promise<void> {
  const result = await compile(entryPath, opts);
  if (result.ok) {
    const binaryPath: string = result.binaryPath;
    void binaryPath;
  }
}
void assertCompileOptionsCompatibility;

/** The historical exported CompileResult itself remains executable-shaped. */
function assertCompileResultCompatibility(result: CompileResult): void {
  if (result.ok) {
    const binaryPath: string = result.binaryPath;
    void binaryPath;
  }
}
void assertCompileResultCompatibility;

function executableNativeFeatures(
  mod: IrModule,
  backend: "llvm",
  optimization: NativeOptimization,
): EarlyExecutableNativeFeatures {
  return {
    backend,
    ...optimizationField(optimization),
    ...executableLinkFeatures(mod),
  };
}

async function compileExecutableNative(
  features: EarlyExecutableNativeFeatures,
  llvmPath: string,
  outPath: string,
  sanitize: boolean,
  ffi: FfiProfile | null,
  windowsSubsystem?: WindowsSubsystem,
  strip?: boolean,
  programSplit: ReturnType<typeof splitLlvmProgram> = null,
  programObjectDependencies: readonly NativeArtifactDependency[] = [],
  onArtifactReady?: NonNullable<Parameters<typeof compileExternalC>[0]["onArtifactReady"]>,
  programPartitions: readonly string[] = [],
  profileGenerate = false,
  /** The kept LLVM text's shared name, when `llvmPath` is the build's private copy of it
   * (BuildSources): the spelling clang sees and native cache keys name. */
  llvmVisiblePath?: string,
): Promise<void> {
  const programIsObject = /\.(?:o|obj)$/.test(llvmPath);
  const runtimePackTarget = programIsObject && !sanitize ? nativeCodegenTarget() : null;
  if (runtimePackTarget !== null) {
    const plan = await createNativeLinkPlan({
      target: runtimePackTarget,
      programObject: llvmPath,
      programPartitions,
      outPath,
      features,
      ffi,
      optimization: features.optimization ?? "release",
      ...(strip ? { strip: true } : {}),
      ...(windowsSubsystem === undefined ? {} : { windowsSubsystem }),
      ...(profileGenerate ? { profileGenerate: true } : {}),
      programObjectDependencies,
    });
    const cacheableLinker =
      onArtifactReady !== undefined &&
      ffi === null &&
      platformLinkerSupportsPersistentCache(process.env, runtimePackTarget);
    await linkNativeExecutable(plan, {
      // A caller-selected linker can be a mutable wrapper with hidden inputs,
      // and a PATH-selected `clang` can be one too. FFI profiles and mutable
      // linker search environments likewise name transitive files that the
      // top-level dependency snapshot cannot prove. Only a direct driver in a
      // stable link environment may publish a reusable final executable.
      ...(cacheableLinker ? { onArtifactReady } : {}),
    });
    return;
  }
  const effectiveProgramSplit =
    programSplit ??
    (!programIsObject && features.optimization === "dev" && features.backend === "llvm" && !sanitize
      ? splitLlvmProgram(await readFile(llvmPath, "utf8"))
      : null);
  if (programIsObject)
    throw new InternalCompilerError("program objects must link against a precompiled runtime pack");
  await compileExternalC({
    ...(llvmVisiblePath === undefined || llvmVisiblePath === llvmPath
      ? { cPath: llvmPath }
      : { cPath: llvmVisiblePath, cSourcePath: llvmPath }),
    outPath,
    cacheIdentity: "scriptc-generated-v1",
    ...optimizationField(features.optimization),
    ...(strip ? { strip: true } : {}),
    ...(windowsSubsystem === undefined ? {} : { windowsSubsystem }),
    ...(effectiveProgramSplit === null
      ? {}
      : {
          programShards: effectiveProgramSplit.shards,
          programPublicSymbols: effectiveProgramSplit.publicSymbols,
        }),
    sanitize,
    regex: features.regex,
    copying: features.copying,
    textDecoderLegacy: features.textDecoderLegacy,
    fileHandle: features.fileHandle,
    fetch: features.fetch,
    ...(features.eventTarget ? { eventTarget: true } : {}),
    ...(features.wasm ? { wasm: true } : {}),
    ...(features.warningReplace ? { warningReplace: true } : {}),
    ...(features.stdioExtended ? { stdioExtended: true } : {}),
    zlib: features.zlib,
    ...(features.brotli ? { brotli: true } : {}),
    assert: features.assert,
    inspect: features.inspect,
    dynInvoke: features.dynInvoke,
    dc: features.dc,
    dynAsync: features.dynAsync,
    ...(features.dynTier ? { dynTier: true } : {}),
    ...(features.streamDyn ? { streamDyn: true } : {}),
    ...(features.handleProps ? { handleProps: true } : {}),
    ...(features.declAdopt ? { declAdopt: true } : {}),
    ...(features.dynForAwait ? { dynForAwait: true } : {}),
    ...(features.eventsOnceSignal ? { eventsOnceSignal: true } : {}),
    ...(features.dynBuffer ? { dynBuffer: true } : {}),
    ...(features.builtinValues ? { builtinValues: true } : {}),
    events: features.events,
    emitter: features.emitter,
    symbol: features.symbol,
    bigint: features.bigint,
    searchParams: features.searchParams,
    qs: features.qs,
    utilPromisify: features.utilPromisify,
    dynBuiltinClass: features.dynBuiltinClass,
    dynBuiltinStream: features.dynBuiltinStream,
    parseArgs: features.parseArgs,
    stream: features.stream,
    net: features.net,
    http: features.http,
    http2: features.http2,
    dgram: features.dgram,
    dnsPromises: features.dnsPromises,
    dgramDyn: features.dgramDyn,
    textCodecDyn: features.textCodecDyn,
    watch: features.watch,
    foreignFfi: features.foreignFfi,
    ...(features.workers ? { workers: true } : {}),
    ...(features.youngNursery ? { youngNursery: true } : {}),
    nodeTest: features.nodeTest,
    tls: features.tls,
    tlsCa: features.tlsCa,
    cipher: features.cipher,
    ecdh: features.ecdh,
    dh: features.dh,
    pki: features.pki,
    ed25519: features.ed25519,
    webcrypto: features.webcrypto,
    perfLoop: features.perfLoop,
    ...(onArtifactReady === undefined ? {} : { onArtifactReady }),
    ...(ffi === null
      ? {}
      : {
          linkInputs: ffi.libraries,
          systemLibraries: ffi.systemLibraries,
          frameworks: ffi.frameworks,
        }),
  });
}

interface NativeProgramObject {
  linkPath: string;
  /** Further partition objects linked after linkPath. */
  partitionPaths: string[];
  artifactPath: string;
  dependencies: NativeArtifactDependency[];
}

async function emitNativeProgramObject(
  entryPath: string,
  opts: CompileRequestOptions,
  llvm: LlvmInput,
  profile: NativeProfileOptions | undefined,
): Promise<NativeProgramObject> {
  const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const artifactPath = join(opts.outDir, `${stem}.helper.o`);
  // compileExecutableNative recognizes object inputs by suffix. The random
  // private name isolates concurrent builds; retain .o so the driver links
  // it rather than attempting to compile it as source.
  const linkPath = `${privateSiblingPath(artifactPath, "native-program-object")}.o`;
  // The validated program-object artifact is a single object by contract.
  const target = nativeCodegenTarget();
  const llvmBytes = llvmInputBytes(llvm);
  const partitions =
    opts.nativeProgramObject === true || target === null ? 1 : nativeProgramPartitions(llvmBytes);
  try {
    const artifact = await emitNativeArtifact({
      outputPath: linkPath,
      llvm,
      outputKind: "obj",
      sourcePath: entryPath,
      optimization: opts.optimization === "dev" ? "0" : "2",
      ...(opts.sanitize === undefined ? {} : { sanitize: opts.sanitize }),
      partitions,
      ...(profile === undefined ? {} : { profile }),
      ...inlineThresholdField(nativeInlineThreshold(opts.optimization, partitions)),
    });
    return {
      linkPath,
      partitionPaths: artifact.outputPaths.slice(1),
      artifactPath,
      dependencies: artifact.dependencies,
    };
  } catch (error) {
    await removeNativeProgramObject(linkPath, nativePartitionPaths(linkPath, partitions));
    throw error;
  }
}

async function removeNativeProgramObject(
  linkPath: string,
  partitionPaths: readonly string[],
): Promise<void> {
  await Promise.all(
    [linkPath, ...partitionPaths].map((path) => rm(path, { force: true }).catch(() => undefined)),
  );
}

/** The request's profile. An indexed profile is read here so every cache keys
 * its bytes. */
async function readNativeProfile(
  opts: CompileRequestOptions,
): Promise<NativeProfileOptions | undefined> {
  if (opts.profileGenerate !== undefined) return { generate: opts.profileGenerate };
  if (opts.profileUse === undefined) return undefined;
  const path = resolve(opts.profileUse);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(
      `cannot read --profile-use file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { use: { path, digest: createHash("sha256").update(bytes).digest("hex") } };
}

function inlineThresholdField(threshold: number | undefined): { inlineThreshold?: number } {
  return threshold === undefined ? {} : { inlineThreshold: threshold };
}

function usesPrecompiledRuntimePack(opts: CompileRequestOptions, backend: "llvm"): boolean {
  if (backend !== "llvm" || opts.sanitize === true) return false;
  return nativeCodegenTarget() !== null;
}

function runtimePackDiagnostic(error: RuntimePackError, entryPath: string): ScrDiagnostic {
  return nativeCodegenDiag(
    error.code === "unsupported" ? "SC3002" : "SC3003",
    error.message,
    entryPath,
    error.hint,
  );
}

interface PreparedExecutable {
  llvmSource: LlvmInput;
  /** The kept LLVM text beside the executable, installed when the build ends. */
  llvmPath: string;
  /** This build's private copy of the LLVM text (BuildSources). */
  llvmSourcePath: string;
  irPath: string | undefined;
  irSourcePath: string | undefined;
  nativeFeatures: EarlyExecutableNativeFeatures;
  programSplit: ReturnType<typeof splitLlvmProgram>;
  sourceTexts: Map<string, string>;
}

/** Finish frontend work in a separate scope so the AST, checker caches and
 * typed IR can be reclaimed before the native optimizer needs its heap. */
async function prepareExecutableInput(
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  timing: CompilationTiming,
  warningSink?: CompileWarningSink,
): Promise<PreparedExecutable | CompileRequestResult> {
  const outputKind = opts.outputKind ?? "exe";
  const prepared = prepareExecutableModule(
    entryPath,
    opts,
    ffi,
    buildPlatform,
    nodeFrontend,
    timing,
  );
  if (!prepared.ok) return prepared;
  const { mod, sourceTexts } = prepared;
  if (warningSink !== undefined && prepared.warnings.length > 0) {
    warningSink.warnings = prepared.warnings;
    warningSink.sourceTexts = sourceTexts;
  }

  const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const defaultSourcePaths = {
    ir: join(opts.outDir, `${stem}.ir.json`),
    llvm: join(opts.outDir, `${stem}.ll`),
  } as const;
  const debugOptions =
    opts.optimization === "dev" && !opts.strip ? { debugSources: sourceTexts } : {};

  if (outputKind === "ir") {
    await mkdir(dirname(opts.outPath), { recursive: true });
    await writeTextParts(opts.outPath, serializeModuleParts(mod, compilerOwnedFileRoots()));
    return { ok: true, artifact: { kind: "ir", path: opts.outPath } };
  }

  if (outputKind === "llvm" || outputKind === "asm" || outputKind === "obj") {
    let llvm: string | readonly string[];
    try {
      llvm = emitLlvmModuleSource(mod, {
        targetTriple: process.env["SCRIPTC_TARGET"] ?? "",
        ...debugOptions,
        pointerBits: buildPlatform === "wasi" ? 32 : 64,
        wasi: buildPlatform === "wasi",
        runtimeAbiMarker: outputKind === "obj",
        objectAudit: opts.sanitize === true,
        lowRegion: lowRegionTarget(buildPlatform, opts.sanitize === true),
        ...(opts.sanitize === true ? { wasmBoundsChecks: true } : {}),
        ...inlineRcOption(opts.optimization, opts.sanitize === true),
        ...targetCpuField(opts.targetCpu),
      });
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      return { ok: false, diagnostics: [llvmRefusalDiag(err, entryPath)], sourceTexts };
    }
    if (outputKind === "llvm") {
      await mkdir(dirname(opts.outPath), { recursive: true });
      await writeTextParts(opts.outPath, llvm);
    } else {
      try {
        await emitNativeArtifact({
          outputPath: opts.outPath,
          llvm,
          outputKind,
          sourcePath: entryPath,
          optimization: opts.optimization === "dev" ? "0" : "2",
          ...(opts.sanitize === undefined ? {} : { sanitize: opts.sanitize }),
        });
      } catch (err) {
        if (!(err instanceof NativeCodegenError)) throw err;
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(err.diagnosticCode, err.message, entryPath)],
          sourceTexts,
        };
      }
    }
    if (outputKind === "obj" && opts.nativeLinkInfo === true) {
      const target = nativeCodegenTarget();
      if (target === null) {
        throw new InternalCompilerError("native object emitted without a native target");
      }
      return {
        ok: true,
        artifact: {
          kind: "obj",
          path: opts.outPath,
          nativeLinkInfo: await createNativeLinkInfo({
            programObject: opts.outPath,
            target,
            features: executableNativeFeatures(mod, "llvm", opts.optimization ?? "release"),
            ffi,
            optimization: opts.optimization ?? "release",
          }),
        },
      };
    }
    return { ok: true, artifact: { kind: outputKind, path: opts.outPath } };
  }

  await mkdir(opts.outDir, { recursive: true });
  const llvmPath = defaultSourcePaths.llvm;
  // The extension keeps clang reading the copy as LLVM IR rather than as a linker input.
  const llvmSourcePath = `${privateSiblingPath(llvmPath, "llvm")}.ll`;
  const backend = "llvm" as const;
  const useRuntimePack =
    opts.nativeProgramObject === true || usesPrecompiledRuntimePack(opts, backend);
  let llvmSource: string | readonly string[];
  try {
    llvmSource = emitLlvmModuleSource(mod, {
      targetTriple: process.env["SCRIPTC_TARGET"] ?? "",
      ...debugOptions,
      pointerBits: buildPlatform === "wasi" ? 32 : 64,
      wasi: buildPlatform === "wasi",
      runtimeAbiMarker: useRuntimePack,
      objectAudit: opts.sanitize === true,
      lowRegion: lowRegionTarget(buildPlatform, opts.sanitize === true),
      ...(opts.sanitize === true ? { wasmBoundsChecks: true } : {}),
      ...inlineRcOption(opts.optimization, opts.sanitize === true),
      ...(opts.detachedExit === true ? { detachedExit: true } : {}),
      ...targetCpuField(opts.targetCpu),
    });
  } catch (err) {
    if (!(err instanceof LlvmUnsupportedError)) throw err;
    return { ok: false, diagnostics: [llvmRefusalDiag(err, entryPath)], sourceTexts };
  }
  timing("llvm-emit");
  await writeLlvmSource(llvmSourcePath, llvmSource);
  timing("llvm-write");
  let irPath: string | undefined;
  let irSourcePath: string | undefined;
  if (opts.emitIr) {
    irPath = defaultSourcePaths.ir;
    irSourcePath = privateSiblingPath(irPath, "ir");
    await writeTextParts(irSourcePath, serializeModuleParts(mod, compilerOwnedFileRoots()));
  }

  const nativeFeatures = executableNativeFeatures(mod, backend, opts.optimization ?? "release");
  timing("link-features");
  const programSplit =
    !useRuntimePack &&
    backend === "llvm" &&
    (opts.optimization ?? "release") === "dev" &&
    !(opts.sanitize ?? false) &&
    typeof llvmSource === "string"
      ? splitLlvmProgram(llvmSource)
      : null;
  timing("llvm-split");
  return {
    llvmSource,
    llvmPath,
    llvmSourcePath,
    irPath,
    irSourcePath,
    nativeFeatures,
    programSplit,
    sourceTexts,
  };
}

/**
 * The kept LLVM text (`<entry stem>.ll`) and IR (`<entry stem>.ir.json`) sit beside the executable,
 * so programs whose entries share a name and are built into one output directory share them. Each
 * build therefore writes, compiles and caches private copies (privateSiblingPath) and moves them to
 * the shared names only when it is done (rename replaces a file in one step): a concurrent build of
 * another program cannot replace the text a build compiles or the translation unit it caches.
 * Builds that compile with the C driver install them before the native build instead
 * (stageDriverBuildSources).
 */
interface BuildSources {
  llvmPath: string;
  llvmSourcePath: string;
  irPath?: string | undefined;
  irSourcePath?: string | undefined;
  /** The shared name already holds the private copy's bytes (a cache hit's restored files): it is
   * left as it is, with its time stamps. */
  llvmPathCurrent?: boolean | undefined;
  irPathCurrent?: boolean | undefined;
}

/** Moves a build's private copies to the shared names, or drops them when that fails. */
async function installBuildSources(sources: BuildSources): Promise<void> {
  const install = async (
    source: string | undefined,
    destination: string | undefined,
    current: boolean | undefined,
  ) => {
    if (source === undefined || destination === undefined || source === destination) return;
    if (current === true) await rm(source, { force: true });
    else await rename(source, destination).catch(() => rm(source, { force: true }));
  };
  await Promise.all([
    install(sources.llvmSourcePath, sources.llvmPath, sources.llvmPathCurrent),
    install(sources.irSourcePath, sources.irPath, sources.irPathCurrent),
  ]);
}

/**
 * A build that compiles the LLVM text with the C driver (no precompiled runtime pack) records the
 * output directory in its native cache proofs, so that directory has to be in its final state before
 * the native build starts. The build therefore installs the shared names first and compiles and
 * caches copies in a private directory outside the output directory. Returns that directory and the
 * copies.
 */
async function stageDriverBuildSources(
  sources: BuildSources,
): Promise<{ dir: string; sources: BuildSources }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-program-"));
  const llvmSourcePath = join(dir, basename(sources.llvmPath));
  const irSourcePath =
    sources.irPath === undefined || sources.irSourcePath === undefined
      ? undefined
      : join(dir, basename(sources.irPath));
  try {
    await Promise.all([
      copyFile(sources.llvmSourcePath, llvmSourcePath),
      irSourcePath === undefined || sources.irSourcePath === undefined
        ? undefined
        : copyFile(sources.irSourcePath, irSourcePath),
    ]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  await installBuildSources(sources);
  return {
    dir,
    sources: { llvmPath: sources.llvmPath, llvmSourcePath, irPath: sources.irPath, irSourcePath },
  };
}

/**
 * The child process that prepares an executable build's input: frontend, lowering and LLVM emission
 * (`runFrontendProcess`). Node's heap keeps the pages a build's frontend used for the life of the
 * process, so running them in a process of their own leaves the native helper the memory they took.
 */
const frontendProcessEntry = fileURLToPath(new URL("./frontend-process.js", import.meta.url));

/**
 * Whether `prepareExecutableInputInChild` may prepare this build: optimized executables, when the
 * compiler runs from its built files. Development builds split the LLVM text in this process, and
 * SCRIPTC_FRONTEND_PROCESS=0 keeps the frontend in-process.
 *
 * compileTracked starts the process only when no earlier build of the same invocation emitted its
 * native program object (`hasEarlyExecutableNativeBuild`). A rebuild finds most native partitions
 * in the helper's cache, so its memory peaks in the frontend, and the parent process would add to
 * that peak.
 */
function preparesInChildProcess(opts: CompileRequestOptions): boolean {
  return (
    process.env["SCRIPTC_FRONTEND_PROCESS"] !== "0" &&
    (opts.outputKind ?? "exe") === "exe" &&
    (opts.optimization ?? "release") !== "dev" &&
    existsSync(frontendProcessEntry)
  );
}

/**
 * The frontend process (frontend-process.ts) of one compile. `start` launches it; it then waits on
 * its stdin for the paths of a request and its result (`run`), and exits once its stdin closes
 * without them (`release`).
 */
class FrontendProcess {
  private child: ChildProcess | undefined;
  private exited: Promise<number | null> | undefined;
  private sent = false;

  /** Whether `start` launched the process. */
  get started(): boolean {
    return this.child !== undefined;
  }

  start(): void {
    if (this.child !== undefined) return;
    const execArgv = frontendProcessExecArgv(process.execArgv);
    const child = spawn(process.execPath, [...execArgv, frontendProcessEntry], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    this.exited = new Promise<number | null>((resolveExit) => {
      child.on("error", () => resolveExit(null));
      child.on("exit", (code) => resolveExit(code));
    });
    // A failed start surfaces as a failed run; the build then prepares its input in-process.
    child.stdin!.on("error", () => undefined);
    this.child = child;
  }

  /** Sends the request at `requestPath`; resolves with the process's exit code. */
  run(requestPath: string, resultPath: string): Promise<number | null> {
    if (this.child === undefined || this.exited === undefined || this.sent)
      return Promise.resolve(null);
    this.sent = true;
    this.child.stdin!.end(`${requestPath}\n${resultPath}\n`);
    return this.exited;
  }

  /** Lets the process exit if no request was sent. */
  release(): void {
    if (this.child === undefined || this.sent) return;
    this.sent = true;
    this.child.stdin!.end();
    // The build is done with it: this process need not wait for it to exit.
    this.child.unref();
    (this.child.stdin as { unref?: () => void }).unref?.();
  }
}

interface FrontendProcessRequest {
  entryPath: string;
  opts: CompileRequestOptions;
  buildPlatform: string;
  /** The compile's SCRIPTC_TIMING clock, which the frontend process's phases continue. */
  timing: TimingClock;
  /** The compile's --provenance-sources mappings, which the frontend process installs. */
  provenance: ProvenanceSources | null;
}

/** What the frontend process sends back. A thrown error comes back as `failed`. */
type FrontendProcessResult =
  | {
      kind: "prepared";
      llvmPath: string;
      /** The build's private copy of the LLVM text (BuildSources), which the native helper reads. */
      nativeInputPath: string;
      llvmBytes: number;
      irPath: string | undefined;
      irSourcePath: string | undefined;
      nativeFeatures: EarlyExecutableNativeFeatures;
      sourceTexts: [string, string][];
      warnings: ScrDiagnostic[];
      frontend: FrontendInputSnapshot;
    }
  | {
      kind: "diagnostics";
      diagnostics: ScrDiagnostic[];
      sourceTexts: [string, string][];
      warnings: ScrDiagnostic[];
      frontend: FrontendInputSnapshot;
    }
  | { kind: "failed" };

/**
 * `prepareExecutableInput` in the frontend process, with the LLVM text passed on as its file. The
 * process's frontend inputs join `frontendInputs` and its warnings `warningSink`. If it fails, the
 * input is prepared here, so the build reports the same errors.
 */
async function prepareExecutableInputInChild(
  frontendProcess: FrontendProcess,
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  timing: CompilationTiming,
  timingClock: TimingClock,
  frontendInputs: FrontendInputTracker,
  warningSink?: CompileWarningSink,
): Promise<PreparedExecutable | CompileRequestResult> {
  await mkdir(opts.outDir, { recursive: true });
  const requestPath = privateSiblingPath(join(opts.outDir, "frontend-request.json"), "frontend");
  const resultPath = privateSiblingPath(join(opts.outDir, "frontend-result.json"), "frontend");
  let result: FrontendProcessResult = { kind: "failed" };
  try {
    const request: FrontendProcessRequest = {
      entryPath,
      opts,
      buildPlatform,
      timing: timingClock,
      provenance: provenanceSources(),
    };
    await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
    const exitCode = await frontendProcess.run(requestPath, resultPath);
    if (exitCode === 0)
      result = JSON.parse(await readFile(resultPath, "utf8")) as FrontendProcessResult;
  } catch {
    result = { kind: "failed" };
  } finally {
    await rm(requestPath, { force: true });
    await rm(resultPath, { force: true });
  }
  if (result.kind === "failed")
    return prepareExecutableInput(entryPath, opts, ffi, buildPlatform, timing, warningSink);
  timing("frontend-process");
  for (const probe of result.frontend.probes) frontendInputs.record(probe);
  if (!result.frontend.stable) frontendInputs.markUnstable();
  const sourceTexts = new Map(result.sourceTexts);
  if (warningSink !== undefined && result.warnings.length > 0) {
    warningSink.warnings = result.warnings;
    warningSink.sourceTexts = sourceTexts;
  }
  if (result.kind === "diagnostics")
    return { ok: false, diagnostics: result.diagnostics, sourceTexts };
  return {
    llvmSource: { file: result.nativeInputPath, bytes: result.llvmBytes },
    llvmPath: result.llvmPath,
    llvmSourcePath: result.nativeInputPath,
    irPath: result.irPath,
    irSourcePath: result.irSourcePath,
    nativeFeatures: result.nativeFeatures,
    programSplit: null,
    sourceTexts,
  };
}

/**
 * The frontend process (frontend-process.ts): prepares the executable input of the request at
 * `requestPath` as `compileTracked` would in-process, and writes what it prepared, without the LLVM
 * text, to `resultPath`.
 */
/** Has the build reuse the diagnostics of the declaration files scriptc
 * supplies (lib-diagnostics.ts) through the build cache at `root`, when the
 * build uses one (executables; source outputs create no cache) and the
 * checker is tsc-ts. */
function configureLibDiagnostics(root: string | null): void {
  let checker: string | undefined;
  try {
    checker = root === null ? undefined : checkerCacheIdentity();
  } catch {
    // A missing checker fails where the build starts it.
    checker = undefined;
  }
  setLibDiagnosticsStore(
    root === null || checker === undefined
      ? null
      : fileVerdictStore(join(root, "lib-diagnostics-v1")),
    checker ?? "",
  );
}

export async function runFrontendProcess(requestPath: string, resultPath: string): Promise<void> {
  const request = JSON.parse(await readFile(requestPath, "utf8")) as FrontendProcessRequest;
  clearCompileSessionCaches();
  setProvenanceSources(request.provenance);
  // The compile that started this process prepared the cache root.
  configureLibDiagnostics(
    (request.opts.outputKind ?? "exe") === "exe" && provenanceSources() === null
      ? await prepareBuildCacheRoot(buildCacheRoot())
      : null,
  );
  const frontendInputs = new FrontendInputTracker();
  const warnings: CompileWarningSink = { warnings: [], sourceTexts: null };
  let result: FrontendProcessResult = { kind: "failed" };
  try {
    let ffi: FfiProfile | null = null;
    if (request.opts.ffiProfilePath !== undefined) {
      const loaded = loadFfiProfile(resolve(request.opts.ffiProfilePath));
      if (!loaded.ok) throw new InternalCompilerError("the FFI profile could not be reloaded");
      ffi = loaded.profile;
    }
    const prepared = await frontendInputs.run(() =>
      prepareExecutableInput(
        request.entryPath,
        request.opts,
        ffi,
        request.buildPlatform,
        compilationTiming(request.timing),
        warnings,
      ),
    );
    const frontend = frontendInputs.snapshot();
    if (!("ok" in prepared)) {
      if (isLlvmFile(prepared.llvmSource))
        throw new InternalCompilerError("in-process preparation returned LLVM text as a file");
      result = {
        kind: "prepared",
        llvmPath: prepared.llvmPath,
        nativeInputPath: prepared.llvmSourcePath,
        llvmBytes: llvmInputBytes(prepared.llvmSource),
        irPath: prepared.irPath,
        irSourcePath: prepared.irSourcePath,
        nativeFeatures: prepared.nativeFeatures,
        sourceTexts: [...prepared.sourceTexts],
        warnings: warnings.warnings,
        frontend,
      };
    } else if (!prepared.ok) {
      result = {
        kind: "diagnostics",
        diagnostics: prepared.diagnostics,
        sourceTexts: [...prepared.sourceTexts],
        warnings: warnings.warnings,
        frontend,
      };
    }
  } catch {
    result = { kind: "failed" };
  } finally {
    setLibDiagnosticsStore(null);
  }
  await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 });
}

async function compileTracked(
  entryPath: string,
  opts: CompileRequestOptions,
  frontendInputs: FrontendInputTracker,
  warningSink?: CompileWarningSink,
  frontendProcess?: FrontendProcess,
): Promise<CompileRequestResult> {
  const timing = compilationTiming();
  const timingStart = Date.now();
  entryPath = resolve(entryPath);
  const outputKind = opts.outputKind ?? "exe";
  if (
    (opts.backend !== undefined && opts.backend !== "llvm") ||
    !["ir", "llvm", "asm", "obj", "exe"].includes(outputKind)
  ) {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag(
          "SC3002",
          "LLVM is the only backend; supported outputs are ir, llvm, asm, obj, and exe",
          entryPath,
        ),
      ],
      sourceTexts: new Map(),
    };
  }
  if (opts.windowsSubsystem !== undefined && outputKind !== "exe") {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag(
          "SC3002",
          "--windows-subsystem is only supported for executable output",
          entryPath,
        ),
      ],
      sourceTexts: new Map(),
    };
  }
  if (opts.strip === true && outputKind !== "exe") {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag("SC3002", "--strip is only supported for executable output", entryPath),
      ],
      sourceTexts: new Map(),
    };
  }
  if (opts.detachedExit === true && outputKind !== "exe") {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag(
          "SC3002",
          "--detached-exit is only supported for executable output",
          entryPath,
        ),
      ],
      sourceTexts: new Map(),
    };
  }
  if (opts.nativeLinkInfo === true && outputKind !== "obj") {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag(
          "SC3002",
          "native link info is available only for object output",
          entryPath,
        ),
      ],
      sourceTexts: new Map(),
    };
  }
  if (opts.nativeProgramObject === true && (outputKind !== "exe" || opts.backend !== "llvm")) {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag(
          "SC3002",
          "native program-object validation requires an executable build with backend explicitly set to llvm",
          entryPath,
        ),
      ],
      sourceTexts: new Map(),
    };
  }
  // Mobile triples are library-mode targets: the archive an embedding app
  // links is the artifact, and only the library-admissible runtime surface
  // is verified on those device classes. The executable lane refuses before
  // any frontend work — a pure env check, so the refusal needs no toolchain.
  if (outputKind === "exe") {
    const entryLoc: SrcLoc = { file: entryPath, start: 0, end: 0 };
    const mobileTarget = mobileLibraryTarget();
    if (mobileTarget !== null) {
      return {
        ok: false,
        diagnostics: [
          targetRefusalDiag(
            mobileTarget,
            "standalone executable builds — mobile targets produce library-mode static archives (scriptc build --lib --profile <profile.json>) for an embedding app to link",
            entryLoc,
          ),
        ],
        sourceTexts: new Map(),
      };
    }
    const rawTarget = process.env["SCRIPTC_TARGET"] ?? "";
    const mobileRefusal = mobileTargetRefusal(rawTarget);
    if (mobileRefusal !== null) {
      return {
        ok: false,
        diagnostics: [{ code: "SC3002", message: mobileRefusal, loc: entryLoc }],
        sourceTexts: new Map(),
      };
    }
  }
  if (outputKind === "exe" && opts.sanitize !== true) {
    const refusal = nativeCodegenTargetRefusal();
    if (refusal !== null)
      return {
        ok: false,
        diagnostics: [nativeCodegenDiag("SC3002", refusal, entryPath)],
        sourceTexts: new Map(),
      };
  }
  let ffi: FfiProfile | null = null;
  let ffiProfileBytes: Uint8Array | null = null;
  if (opts.ffiProfilePath !== undefined) {
    const ffiProfilePath = resolve(opts.ffiProfilePath);
    const loaded = loadFfiProfile(ffiProfilePath);
    if (!loaded.ok) {
      return { ok: false, diagnostics: loaded.diagnostics, sourceTexts: new Map() };
    }
    ffi = loaded.profile;
    ffiProfileBytes = loaded.profileBytes;
  }
  let buildPlatform: string;
  if (outputKind === "exe") {
    // Target semantics are needed before choosing the helper/runtime-pack
    // path. Do not make them contingent on the legacy C-driver resolver:
    // an LLVM-owned WASI build deliberately needs no SCRIPTC_CC.
    try {
      buildPlatform = sourceTargetPlatform();
    } catch (err) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "SC3002",
            message: err instanceof Error ? err.message : String(err),
            loc: { file: entryPath, start: 0, end: 0 },
          },
        ],
        sourceTexts: new Map(),
      };
    }
  } else {
    try {
      buildPlatform = sourceTargetPlatform();
    } catch (err) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "SC3002",
            message: err instanceof Error ? err.message : String(err),
            loc: { file: entryPath, start: 0, end: 0 },
          },
        ],
        sourceTexts: new Map(),
      };
    }
    if (outputKind === "asm" || outputKind === "obj") {
      const refusal = nativeCodegenTargetRefusal();
      if (refusal !== null) {
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag("SC3002", refusal, entryPath)],
          sourceTexts: new Map(),
        };
      }
      if (opts.sanitize === true) {
        return {
          ok: false,
          diagnostics: [
            nativeCodegenDiag(
              "SC3002",
              `--sanitize is not supported with --emit=${outputKind}; AddressSanitizer instrumentation parity is not available in the LLVM native helper yet`,
              entryPath,
            ),
          ],
          sourceTexts: new Map(),
        };
      }
    }
  }
  const targetCpuRefusal = targetCpuTargetRefusal(
    opts.targetCpu,
    buildPlatform,
    nativeCodegenTarget()?.architecture ?? process.arch,
  );
  if (targetCpuRefusal !== null) {
    return {
      ok: false,
      diagnostics: [nativeCodegenDiag("SC3002", targetCpuRefusal, entryPath)],
      sourceTexts: new Map(),
    };
  }
  try {
    windowsSubsystemLinkerArgs(buildPlatform, opts.windowsSubsystem);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag("SC3002", err instanceof Error ? err.message : String(err), entryPath),
      ],
      sourceTexts: new Map(),
    };
  }
  const profileRefusal = nativeProfileRefusal({
    ...opts,
    outputKind,
    optimization: opts.optimization ?? "release",
    sanitize: opts.sanitize ?? false,
    platform: buildPlatform,
  });
  let profile: NativeProfileOptions | undefined;
  try {
    if (profileRefusal !== null) throw new Error(profileRefusal);
    profile = await readNativeProfile(opts);
  } catch (err) {
    return {
      ok: false,
      diagnostics: [
        nativeCodegenDiag("SC3002", err instanceof Error ? err.message : String(err), entryPath),
      ],
      sourceTexts: new Map(),
    };
  }
  const cacheRoot =
    outputKind === "exe" && provenanceSources() === null
      ? await prepareBuildCacheRoot(buildCacheRoot())
      : null;
  configureLibDiagnostics(cacheRoot);
  let earlyCacheOptions: EarlyExecutableCacheOptions | null = null;
  if (outputKind === "exe") {
    const helperObjectRoute =
      opts.nativeProgramObject === true || usesPrecompiledRuntimePack(opts, "llvm");
    const routeOptions: Omit<
      EarlyExecutableCacheOptions,
      "implementation" | "implementationDependencies" | "nativeEnvironment"
    > = {
      entryPath,
      outDir: opts.outDir,
      outPath: opts.outPath,
      emitIr: opts.emitIr ?? false,
      sanitize: opts.sanitize ?? false,
      backend: "llvm",
      ...optimizationField(opts.optimization),
      ...(opts.strip ? { strip: true as const } : {}),
      ...(opts.windowsSubsystem === "gui" ? { windowsSubsystem: "gui" as const } : {}),
      ...(opts.detachedExit === true ? { detachedExit: true as const } : {}),
      ...targetCpuField(opts.targetCpu),
      ...(profile === undefined ? {} : { profile: nativeProfileKey(profile) }),
      ...checkerField(),
      ...(youngNurseryRequested() ? { youngNursery: true as const } : {}),
      npmStatic: opts.npmStatic ?? null,
      ffiProfile:
        opts.ffiProfilePath === undefined || ffiProfileBytes === null
          ? null
          : { path: opts.ffiProfilePath, bytes: ffiProfileBytes },
      target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}:${
        opts.nativeProgramObject === true
          ? "helper-object"
          : helperObjectRoute
            ? "runtime-pack"
            : "driver-tu"
      }`,
      compiler: [
        helperObjectRoute
          ? resolvePlatformLinker(process.env, nativeCodegenTarget()?.defaultLinker)
          : (process.env["SCRIPTC_CC"] ?? "clang"),
      ],
      nodeVersion: process.version,
    };
    // The frontend process prepares the first build of an invocation (preparesInChildProcess).
    // Started here, it loads the compiler while this process computes the rest of the cache key.
    if (
      frontendProcess !== undefined &&
      !(await hasEarlyExecutableNativeBuild(cacheRoot, routeOptions))
    )
      frontendProcess.start();
    // Package content and native driver discovery are independent inputs to
    // the same cache key. Start both before waiting so edits do not pay their
    // filesystem and subprocess latency serially.
    const [implementation, nativeEnvironment] = await Promise.all([
      compilerImplementationIdentity(),
      helperObjectRoute
        ? executableLinkerEnvironmentFingerprint(process.env, nativeCodegenTarget()?.defaultLinker)
        : executableNativeEnvironmentFingerprint(),
    ]);
    earlyCacheOptions = {
      ...routeOptions,
      nativeEnvironment,
      implementation: implementation.digest,
      implementationDependencies: implementation.dependencies,
    };
  }
  const earlyHit =
    earlyCacheOptions === null
      ? null
      : await readEarlyExecutableCache(cacheRoot, earlyCacheOptions);
  if (earlyHit !== null) {
    timing("executable-cache-hit");
    if (earlyCacheOptions === null) {
      throw new InternalCompilerError("executable cache hit without executable cache options");
    }
    // A cached build repeats its performance warning (SC6101): the code it
    // names is just as untyped as when it was built.
    if (warningSink !== undefined && earlyHit.performance !== undefined) {
      warningSink.warnings = earlyHit.performance;
      warningSink.sourceTexts = new Map();
    }
    const executableCacheOptions = earlyCacheOptions;
    // Route/proof metadata is independently evictable. A full-compiler
    // fallback that still finds the validated payload repairs that lightweight
    // index so the next identical CLI invocation can avoid this module graph.
    await publishEarlyExecutableRoute(cacheRoot, executableCacheOptions).catch(() => undefined);
    if (earlyHit.executableRestored) {
      await pruneBuildCache(cacheRoot);
      timing("complete");
      return {
        ok: true,
        artifact: {
          kind: "exe",
          path: opts.outPath,
          translationUnitPath: earlyHit.llvmPath,
          backend: earlyHit.native.backend,
        },
        binaryPath: opts.outPath,
        llvmPath: earlyHit.llvmPath,
        backend: earlyHit.native.backend,
        ...(earlyHit.irPath === undefined ? {} : { irPath: earlyHit.irPath }),
      };
    }
    // The build's private copies of the cached LLVM text and IR (BuildSources).
    const hitSources: BuildSources = {
      llvmPath: earlyHit.llvmPath,
      llvmSourcePath: earlyHit.llvmSourcePath ?? earlyHit.llvmPath,
      irPath: earlyHit.irPath,
      irSourcePath: earlyHit.irSourcePath,
      llvmPathCurrent: earlyHit.llvmPathCurrent,
      irPathCurrent: earlyHit.irPathCurrent,
    };
    // What the native build compiles and the cache publishes: hitSources, or their staged copies.
    let nativeSources = hitSources;
    let stagedDir: string | null = null;
    let nativeInputPath = hitSources.llvmSourcePath;
    let nativeProgramObject: NativeProgramObject | null = null;
    const useRuntimePack =
      opts.nativeProgramObject === true ||
      usesPrecompiledRuntimePack(opts, earlyHit.native.backend);
    try {
      if (useRuntimePack) {
        if (earlyHit.native.backend !== "llvm") {
          throw new InternalCompilerError(
            "native program-object cache hit restored a non-LLVM translation unit",
          );
        }
        try {
          nativeProgramObject = await emitNativeProgramObject(
            entryPath,
            opts,
            // A large program's LLVM exceeds the engine's string limit as one
            // string; the emitter takes it in parts, as on a cold build.
            await readTextParts(hitSources.llvmSourcePath),
            profile,
          );
          nativeInputPath = nativeProgramObject.linkPath;
        } catch (err) {
          if (!(err instanceof NativeCodegenError)) throw err;
          return {
            ok: false,
            diagnostics: [nativeCodegenDiag(err.diagnosticCode, err.message, entryPath)],
            sourceTexts: new Map(),
          };
        }
      } else {
        const staged = await stageDriverBuildSources(hitSources);
        stagedDir = staged.dir;
        nativeSources = staged.sources;
        nativeInputPath = nativeSources.llvmSourcePath;
      }
      await compileExecutableNative(
        earlyHit.native,
        nativeInputPath,
        opts.outPath,
        opts.sanitize ?? false,
        ffi,
        opts.windowsSubsystem,
        opts.strip,
        null,
        nativeProgramObject?.dependencies,
        opts.nativeProgramObject === true
          ? undefined
          : async ({ dependencies }) => {
              await publishEarlyExecutableCache(cacheRoot, executableCacheOptions, {
                ...earlyHit,
                llvmPath: nativeSources.llvmSourcePath,
                ...(nativeSources.irSourcePath === undefined
                  ? {}
                  : { irPath: nativeSources.irSourcePath }),
                executableRestored: true,
                nativeDependencies: dependencies,
                frontend: earlyHit.frontend,
              });
            },
        nativeProgramObject?.partitionPaths,
        profile?.generate !== undefined,
        hitSources.llvmPath,
      );
      if (nativeProgramObject !== null && opts.nativeProgramObject === true) {
        await rename(nativeProgramObject.linkPath, nativeProgramObject.artifactPath);
      }
    } catch (err) {
      if (err instanceof RuntimePackError) {
        return {
          ok: false,
          diagnostics: [runtimePackDiagnostic(err, entryPath)],
          sourceTexts: new Map(),
        };
      }
      if (ffi !== null && err instanceof CcCompileError) {
        return {
          ok: false,
          diagnostics: [
            ffiNativeBuildDiag(ffiNativeBuildDetail(err), opts.ffiProfilePath ?? entryPath),
          ],
          sourceTexts: new Map(),
        };
      }
      throw err;
    } finally {
      if (nativeProgramObject !== null) {
        await removeNativeProgramObject(
          nativeProgramObject.linkPath,
          nativeProgramObject.partitionPaths,
        );
      }
      if (stagedDir === null) await installBuildSources(hitSources);
      else await rm(stagedDir, { recursive: true, force: true });
    }
    await pruneBuildCache(cacheRoot);
    return {
      ok: true,
      artifact: {
        kind: "exe",
        path: opts.outPath,
        translationUnitPath: earlyHit.llvmPath,
        backend: earlyHit.native.backend,
      },
      binaryPath: opts.outPath,
      llvmPath: earlyHit.llvmPath,
      backend: earlyHit.native.backend,
      ...(earlyHit.irPath === undefined ? {} : { irPath: earlyHit.irPath }),
    };
  }
  timing("executable-cache-miss");
  const prepared =
    frontendProcess?.started === true
      ? await prepareExecutableInputInChild(
          frontendProcess,
          entryPath,
          opts,
          ffi,
          buildPlatform,
          timing,
          { start: timingStart, previous: Date.now() },
          frontendInputs,
          warningSink,
        )
      : await prepareExecutableInput(entryPath, opts, ffi, buildPlatform, timing, warningSink);
  if ("ok" in prepared) return prepared;
  const buildSources: BuildSources = {
    llvmPath: prepared.llvmPath,
    llvmSourcePath: prepared.llvmSourcePath,
    irPath: prepared.irPath,
    irSourcePath: prepared.irSourcePath,
  };
  const { llvmSource, llvmPath, irPath } = prepared;
  const { nativeFeatures, programSplit, sourceTexts } = prepared;
  // What the native build compiles and the cache publishes: buildSources, or their staged copies.
  let { llvmSourcePath, irSourcePath } = buildSources;
  let stagedDir: string | null = null;
  const backend = "llvm" as const;
  await mkdir(dirname(opts.outPath), { recursive: true });
  if (earlyCacheOptions === null) {
    throw new InternalCompilerError("executable emission without executable cache options");
  }
  const executableCacheOptions = earlyCacheOptions;
  let publishedExecutable = false;
  let nativeProgramObject: NativeProgramObject | null = null;
  try {
    const useRuntimePack =
      opts.nativeProgramObject === true || usesPrecompiledRuntimePack(opts, backend);
    if (useRuntimePack) {
      if (backend !== "llvm" || llvmSource === null) {
        throw new InternalCompilerError(
          "native program-object validation requires the LLVM backend",
        );
      }
      try {
        nativeProgramObject = await emitNativeProgramObject(entryPath, opts, llvmSource, profile);
        timing("native-object");
        await recordEarlyExecutableNativeBuild(cacheRoot, executableCacheOptions).catch(
          () => undefined,
        );
      } catch (err) {
        if (!(err instanceof NativeCodegenError)) throw err;
        return {
          ok: false,
          diagnostics: [nativeCodegenDiag(err.diagnosticCode, err.message, entryPath)],
          sourceTexts,
        };
      }
    } else {
      const staged = await stageDriverBuildSources(buildSources);
      stagedDir = staged.dir;
      ({ llvmSourcePath, irSourcePath } = staged.sources);
    }
    await compileExecutableNative(
      nativeFeatures,
      nativeProgramObject?.linkPath ?? llvmSourcePath,
      opts.outPath,
      opts.sanitize ?? false,
      ffi,
      opts.windowsSubsystem,
      opts.strip,
      programSplit,
      nativeProgramObject?.dependencies,
      opts.nativeProgramObject === true
        ? undefined
        : async ({ dependencies }) => {
            await publishEarlyExecutableCache(cacheRoot, executableCacheOptions, {
              llvmPath: llvmSourcePath,
              native: nativeFeatures,
              executableRestored: true,
              nativeDependencies: dependencies,
              frontend: frontendInputs.snapshot(),
              ...(irSourcePath === undefined ? {} : { irPath: irSourcePath }),
              ...performanceWarnings(warningSink),
            });
            publishedExecutable = true;
          },
      nativeProgramObject?.partitionPaths,
      profile?.generate !== undefined,
      llvmPath,
    );
    timing("native-link");
    if (nativeProgramObject !== null && opts.nativeProgramObject === true) {
      await rename(nativeProgramObject.linkPath, nativeProgramObject.artifactPath);
    }
    if (!publishedExecutable) {
      await publishEarlyExecutableCache(cacheRoot, executableCacheOptions, {
        llvmPath: llvmSourcePath,
        native: nativeFeatures,
        executableRestored: false,
        frontend: frontendInputs.snapshot(),
        ...(irSourcePath === undefined ? {} : { irPath: irSourcePath }),
        ...performanceWarnings(warningSink),
      }).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof RuntimePackError) {
      return { ok: false, diagnostics: [runtimePackDiagnostic(err, entryPath)], sourceTexts };
    }
    if (ffi !== null && err instanceof CcCompileError) {
      return {
        ok: false,
        diagnostics: [
          ffiNativeBuildDiag(ffiNativeBuildDetail(err), opts.ffiProfilePath ?? entryPath),
        ],
        sourceTexts,
      };
    }
    throw err;
  } finally {
    if (nativeProgramObject !== null) {
      await removeNativeProgramObject(
        nativeProgramObject.linkPath,
        nativeProgramObject.partitionPaths,
      );
    }
    if (stagedDir === null) await installBuildSources(buildSources);
    else await rm(stagedDir, { recursive: true, force: true });
  }
  await pruneBuildCache(cacheRoot);
  timing("complete");
  return {
    ok: true,
    artifact: {
      kind: "exe",
      path: opts.outPath,
      translationUnitPath: llvmPath,
      backend,
    },
    binaryPath: opts.outPath,
    llvmPath,
    backend,
    ...(irPath !== undefined ? { irPath } : {}),
  };
}

/* ── library emission mode ───────────────────────────────────────────────
 * `scriptc build --lib --profile <file>`: compile the profile's ONE entry module
 * to a linkable static archive (<name>.lib.a) exporting exactly the
 * profile-declared C-ABI symbols — no main, no event loop, no signal
 * handlers, traps to the host's registered sink. The profile pins the
 * emission; there is no fallback concept on this path (an out-of-tier
 * program under emission "llvm" reports SC3001). */

function libraryNativeFeatures(mod: IrModule, backend: "llvm"): EarlyLibraryNativeFeatures {
  const features = moduleRuntimeFeatures(mod);
  return {
    backend,
    regex: features.regex,
    assert: features.assert,
    inspect: features.inspect,
    symbol: features.symbol,
    bigint: features.bigint,
    searchParams: features.searchParams,
    emitter: features.emitter,
    zlib: features.zlib,
    copying: features.copying,
    textDecoderLegacy: features.legacyTextDecoder,
    dynInvoke: features.dynInvoke,
    ...(features.dynBuffer ? { dynBuffer: true } : {}),
    ...(features.dynTier ? { dynTier: true } : {}),
    ...(mod.lib?.identity !== undefined ? { buildId: mod.lib.identity.buildId } : {}),
  };
}

async function compileLibraryNative(
  profile: LibraryProfile,
  llvmPath: string,
  archivePath: string,
  sanitize: boolean,
  features: EarlyLibraryNativeFeatures,
): Promise<void> {
  const wasmTarget = nativeCodegenTarget();
  if (wasmTarget?.platform === "wasi") {
    await compilePackedLibrary(
      {
        cPath: llvmPath,
        outPath: archivePath,
        optimization: profile.optimization,
        ...features,
      },
      wasmTarget,
      libraryWasmExports(profile),
    );
    return;
  }
  const localizeSymbols = libraryLocalizeSymbols(profile);
  let identityLlvmSource: string | undefined;
  let programSource: string | undefined;
  if (
    profile.sidecar !== null ||
    (profile.emission === "llvm" && profile.optimization === "dev" && !sanitize)
  ) {
    const publicSource = await readFile(llvmPath, "utf8");
    programSource = publicSource;
  }
  if (profile.sidecar !== null) {
    if (features.buildId === undefined)
      throw new InternalCompilerError("library identity TU has no build id");
    const withoutIdentity = stripLibraryIdentity(programSource!);
    if (withoutIdentity === programSource) {
      throw new InternalCompilerError("generated public library TU has no identity region");
    }
    programSource = withoutIdentity;
    identityLlvmSource = emitLibraryIdentityLines(
      {
        buildIdSymbol: profile.sidecar.buildIdSymbol,
        abiVersionSymbol: profile.sidecar.abiVersionSymbol,
        buildId: features.buildId,
        abiVersion: profile.sidecar.abiVersion,
      },
      "",
    ).join("\n");
  }
  const llvmSplit =
    profile.emission === "llvm" &&
    profile.optimization === "dev" &&
    !sanitize &&
    programSource !== undefined
      ? splitLlvmLibraryProgram(programSource)
      : null;
  const packTarget = !sanitize ? nativeCodegenTarget() : null;
  if (!sanitize && packTarget === null)
    throw new NativeCodegenError(
      "SC3002",
      nativeCodegenTargetRefusal() ?? "unsupported library target",
    );
  const archiveOptions: Parameters<typeof compileExternalCLibrary>[0] = {
    cPath: llvmPath,
    ...(programSource !== undefined ? { programSource } : {}),
    ...(identityLlvmSource !== undefined ? { identityLlvmSource } : {}),
    ...(llvmSplit !== null
      ? {
          programShards: llvmSplit.shards,
          programPublicSymbols: llvmSplit.publicSymbols,
        }
      : {}),
    outPath: archivePath,
    cacheIdentity: "scriptc-generated-library-v1",
    sanitize,
    optimization: profile.optimization,
    ...(localizeSymbols !== undefined ? { localizeSymbols } : {}),
    ...(profile.instancePerThread ? { threadInstances: true } : {}),
    regex: features.regex,
    assert: features.assert,
    inspect: features.inspect,
    symbol: features.symbol,
    bigint: features.bigint,
    searchParams: features.searchParams,
    emitter: features.emitter,
    zlib: features.zlib,
    copying: features.copying,
    textDecoderLegacy: features.textDecoderLegacy,
    dynInvoke: features.dynInvoke,
    ...(features.dynBuffer === true ? { dynBuffer: true } : {}),
    ...(features.dynTier === true ? { dynTier: true } : {}),
  };
  if (packTarget !== null) await compilePackedLibrary(archiveOptions, packTarget);
  else await compileExternalCLibrary(archiveOptions);
}

async function emitSemanticLibraryHit(
  hit: SemanticLibraryCacheHit,
  profile: LibraryProfile,
  opts: CompileLibraryOptions,
  archivePath: string,
  cacheRoot: string | null,
  cacheOptions: EarlyLibraryCacheOptions,
  timing: (phase: string, detail?: Record<string, unknown>) => void,
): Promise<CompileLibraryResult> {
  const mod = hit.mod;
  const rootDir = dirname(resolve(opts.profilePath));
  let sidecarJson = hit.sidecarJson;
  if (profile.sidecar !== null) {
    if (mod.lib?.identity === undefined || sidecarJson === null) {
      throw new InternalCompilerError("semantic library cache lost sidecar identity metadata");
    }
    const modules = canonicalModuleGraph(rootDir, hit.sourceTexts);
    const { buildId, sourceHash } = libraryIdentityHashes(
      compilerReleaseVersion(),
      profile.profileBytes,
      modules,
    );
    mod.lib.identity.buildId = buildId;
    hit.native.buildId = buildId;
    sidecarJson = updateSidecarIdentity(sidecarJson, buildId, sourceHash);
  }
  const validation = validateModule(mod);
  if (validation.length > 0) {
    return {
      ok: false,
      diagnostics: validation.map((violation) => iceDiag(violation.message, violation.loc)),
      sourceTexts: hit.sourceTexts,
    };
  }
  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(profile.entry).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const llvmPath = join(opts.outDir, `${stem}.lib.ll`);
  let translationUnit = hit.translationUnit;
  if (profile.sidecar !== null) {
    translationUnit = replaceLibraryIdentity(translationUnit, mod.lib!.identity!);
  }
  await writeFile(llvmPath, translationUnit);
  timing("semantic-tu-restore", { output_bytes: Buffer.byteLength(translationUnit) });
  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.lib.ir.json`);
    await writeTextParts(irPath, serializeModuleParts(mod, compilerOwnedFileRoots()));
  }
  await compileLibraryNative(profile, llvmPath, archivePath, opts.sanitize ?? false, hit.native);
  timing("native-archive");
  let sidecarPath: string | undefined;
  if (sidecarJson !== null) {
    sidecarPath =
      profile.sidecar!.path !== null
        ? resolve(dirname(archivePath), profile.sidecar!.path)
        : `${archivePath}.contract.json`;
    await writeFile(sidecarPath, sidecarJson);
  }
  await publishEarlyLibraryCache(cacheRoot, cacheOptions, {
    llvmPath,
    native: hit.native,
    frontend: hit.frontend,
    semantic: { mod, sources: hit.sourceTexts },
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  }).catch(() => undefined);
  await pruneBuildCache(cacheRoot);
  timing("semantic-cache-publish");
  timing("complete");
  return {
    ok: true,
    archivePath,
    llvmPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}

export async function compileLibrary(opts: CompileLibraryOptions): Promise<CompileLibraryResult> {
  clearCompileSessionCaches();
  const frontendInputs = new FrontendInputTracker();
  try {
    return await frontendInputs.run(() => compileLibraryTracked(opts, frontendInputs));
  } catch (error) {
    if (error instanceof RuntimePackError)
      return {
        ok: false,
        diagnostics: [runtimePackDiagnostic(error, opts.profilePath)],
        sourceTexts: new Map(),
      };
    if (error instanceof NativeCodegenError)
      return {
        ok: false,
        diagnostics: [nativeCodegenDiag(error.diagnosticCode, error.message, opts.profilePath)],
        sourceTexts: new Map(),
      };
    throw error;
  }
}

async function compileLibraryTracked(
  opts: CompileLibraryOptions,
  frontendInputs: FrontendInputTracker,
): Promise<CompileLibraryResult> {
  const timingOn = process.env["SCRIPTC_TIMING"] === "1";
  const timingStart = performance.now();
  let timingLast = timingStart;
  const timing = (phase: string, detail: Record<string, unknown> = {}): void => {
    if (!timingOn) return;
    const now = performance.now();
    process.stderr.write(
      `scriptc timing ${JSON.stringify({
        phase,
        phase_ms: Math.round((now - timingLast) * 10) / 10,
        total_ms: Math.round((now - timingStart) * 10) / 10,
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        ...detail,
      })}\n`,
    );
    timingLast = now;
  };
  const loadedProfile = loadLibraryProfile(resolve(opts.profilePath));
  timing("profile-load");
  if (!loadedProfile.ok) {
    return { ok: false, diagnostics: loadedProfile.diagnostics, sourceTexts: new Map() };
  }
  const profile = loadedProfile.profile;
  const entryPath = profile.entry;
  const profileDir = dirname(resolve(opts.profilePath));
  for (let directory = dirname(entryPath); ; directory = dirname(directory)) {
    for (const name of ["tsconfig.json", "package.json"]) {
      // Project configuration and package-realm metadata can affect the
      // frontend even when TypeScript did not request their bytes through
      // its delegated filesystem callbacks (tsgo may read them server-side).
      frontendInputs.run(() => {
        const path = join(directory, name);
        trackedReadFile(path);
      });
    }
    if (directory === profileDir || dirname(directory) === directory) break;
  }
  // Mobile-target admission first — a pure env/host check, so a refused
  // pairing never reaches toolchain discovery. iOS targets (device and
  // simulator) build on darwin hosts only: the Apple SDK sysroot and the
  // Mach-O localization linker live there. Android builds from any host
  // with an NDK; a near-miss mobile spelling refuses with the supported
  // set named.
  {
    const mobileRefusal = mobileTargetRefusal(process.env["SCRIPTC_TARGET"] ?? "");
    if (mobileRefusal !== null) {
      return {
        ok: false,
        diagnostics: decorateLibraryRefusals(
          [{ code: "SC3002", message: mobileRefusal, loc: { file: entryPath, start: 0, end: 0 } }],
          profile,
        ),
        sourceTexts: new Map(),
      };
    }
  }

  const buildPlatform = buildTargetPlatform();
  const archivePath =
    opts.outPath ??
    join(
      opts.outDir,
      `${basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "")}${buildPlatform === "wasi" ? ".wasm" : ".lib.a"}`,
    );
  if (buildPlatform === "wasi") {
    const refusal = libraryWasmRefusal(profile, opts.sanitize ?? false);
    if (refusal !== null) return { ok: false, diagnostics: [refusal], sourceTexts: new Map() };
  }

  // Multi-instance library mode (abi.localize_runtime) localizes per
  // OBJECT FORMAT: ELF and COFF archives localize from any host (cross
  // ELF merges through the cross driver's own lld; COFF merges and
  // demotes in process — see native-toolchain.ts's localizeLibraryObjects), and Mach-O
  // localization runs the macOS host linker, so macos and ios targets
  // admit darwin hosts only (the mobile admission above already refused
  // an ios triple off darwin). Everything else refuses before frontend/
  // backend work, naming the pairing. WASI refuses localization above:
  // each WebAssembly.Instance already owns its runtime state.
  if (profile.localizeRuntime && buildPlatform !== "wasi") {
    const packTarget = nativeCodegenTarget();
    const driver = opts.sanitize
      ? resolveCc()
      : {
          target: packTarget?.llvmTriple ?? process.env["SCRIPTC_TARGET"] ?? null,
        };
    const platform = buildPlatform;
    const targetArch = driver.target?.split("-", 1)[0] ?? null;
    // Native Linux retains its host-binutils implementation. Cross ELF is
    // rebuilt in process and currently accepts the two verified ELF64,
    // little-endian architectures; COFF is rebuilt in process and accepts
    // AMD64 only. Keep this preflight in lockstep with object-localize.ts so
    // unsupported object classes refuse before frontend/backend work.
    const supported =
      (platform === "linux" &&
        (driver.target === null || targetArch === "x86_64" || targetArch === "aarch64")) ||
      (platform === "win32" &&
        (driver.target === null ? process.arch === "x64" : targetArch === "x86_64")) ||
      (platform === "darwin" && process.platform === "darwin");
    if (!supported) {
      const subject =
        platform === "win32"
          ? "runtime-localized (multi-instance) library archives (COFF localization currently requires x86_64)"
          : platform === "linux" && driver.target !== null
            ? "runtime-localized (multi-instance) library archives (cross-ELF localization currently requires x86_64 or aarch64)"
            : platform === "darwin"
              ? `runtime-localized (multi-instance) library archives on ${process.platform} hosts (Mach-O localization runs the macOS host linker)`
              : "runtime-localized (multi-instance) library archives";
      return {
        ok: false,
        diagnostics: decorateLibraryRefusals(
          [
            targetRefusalDiag(process.env["SCRIPTC_TARGET"] || driver.target || platform, subject, {
              file: entryPath,
              start: 0,
              end: 0,
            }),
          ],
          profile,
        ),
        sourceTexts: new Map(),
      };
    }
  }

  const cacheRoot =
    provenanceSources() === null ? await prepareBuildCacheRoot(buildCacheRoot()) : null;
  const earlyCacheOptions: EarlyLibraryCacheOptions = {
    profilePath: opts.profilePath,
    profileBytes: profile.profileBytes,
    entryPath,
    outDir: opts.outDir,
    ...(opts.outPath !== undefined ? { outPath: opts.outPath } : {}),
    emitIr: opts.emitIr ?? false,
    sanitize: opts.sanitize ?? false,
    target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}`,
    compiler: [process.env["SCRIPTC_CC"] ?? "clang"],
    nodeVersion: process.version,
    implementation: await libraryFrontendImplementationFingerprint(),
  };
  const earlyHit = await readEarlyLibraryCache(
    cacheRoot,
    earlyCacheOptions,
    profile.sidecar === null ? undefined : profile.sidecar.path,
  );
  if (earlyHit !== null) {
    timing("early-cache-hit");
    await compileLibraryNative(
      profile,
      earlyHit.llvmPath,
      archivePath,
      opts.sanitize ?? false,
      earlyHit.native,
    );
    timing("native-archive");
    timing("complete");
    return {
      ok: true,
      archivePath,
      llvmPath: earlyHit.llvmPath,
      backend: earlyHit.native.backend,
      ...(earlyHit.irPath !== undefined ? { irPath: earlyHit.irPath } : {}),
      ...(earlyHit.sidecarPath !== undefined ? { sidecarPath: earlyHit.sidecarPath } : {}),
    };
  }
  timing("early-cache-miss");
  const semanticHit = await readSemanticLibraryCache(
    cacheRoot,
    earlyCacheOptions,
    profile.sidecar === null ? undefined : profile.sidecar.path,
  );
  if (semanticHit !== null) {
    timing("semantic-cache-hit", { changed_sources: semanticHit.changedSources.length });
    return emitSemanticLibraryHit(
      semanticHit,
      profile,
      opts,
      archivePath,
      cacheRoot,
      earlyCacheOptions,
      timing,
    );
  }
  timing("semantic-cache-miss");

  const prepared = prepareLibrary(
    profile,
    opts.profilePath,
    compilerReleaseVersion(),
    buildPlatform,
    nodeFrontend,
    timing,
  );
  if (!prepared.ok) return prepared;
  const { mod, sourceTexts, sidecarJson } = prepared;
  const fail = (diagnostics: ScrDiagnostic[]): CompileLibraryResult => ({
    ok: false,
    diagnostics: decorateLibraryRefusals(diagnostics, profile),
    sourceTexts,
  });

  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(entryPath).replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "");
  const llvmPath = join(opts.outDir, `${stem}.lib.ll`);
  try {
    const ll = emitLlvmModuleSource(mod, {
      targetTriple: process.env["SCRIPTC_TARGET"] ?? "",
      pointerBits: buildPlatform === "wasi" ? 32 : 64,
      wasi: buildPlatform === "wasi",
      objectAudit: opts.sanitize === true,
      ...inlineRcOption(profile.optimization, opts.sanitize === true),
    });
    timing("llvm-emit", {
      output_bytes:
        typeof ll === "string"
          ? Buffer.byteLength(ll)
          : ll.reduce((bytes, part) => bytes + Buffer.byteLength(part), 0),
    });
    await writeTextParts(llvmPath, ll);
    timing("llvm-write");
  } catch (err) {
    if (!(err instanceof LlvmUnsupportedError)) throw err;
    return fail([llvmRefusalDiag(err, entryPath)]);
  }

  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.lib.ir.json`);
    await writeTextParts(irPath, serializeModuleParts(mod, compilerOwnedFileRoots()));
  }

  const nativeFeatures = libraryNativeFeatures(mod, profile.emission);
  await compileLibraryNative(
    profile,
    llvmPath,
    archivePath,
    opts.sanitize ?? false,
    nativeFeatures,
  );
  timing("native-archive");

  // The sidecar lands beside the compiled object, written by the same
  // invocation (profile-declared name; the neutral default when the
  // profile states none is <out>.contract.json).
  let sidecarPath: string | undefined;
  if (sidecarJson !== null) {
    sidecarPath =
      profile.sidecar!.path !== null
        ? resolve(dirname(archivePath), profile.sidecar!.path)
        : `${archivePath}.contract.json`;
    await writeFile(sidecarPath, sidecarJson);
  }
  const earlyPublish: EarlyLibraryCachePublish = {
    llvmPath,
    native: nativeFeatures,
    frontend: frontendInputs.snapshot(),
    semantic: { mod, sources: sourceTexts },
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
  await publishEarlyLibraryCache(cacheRoot, earlyCacheOptions, earlyPublish).catch(() => undefined);
  await pruneBuildCache(cacheRoot);
  timing("early-cache-publish");
  timing("complete");
  return {
    ok: true,
    archivePath,
    llvmPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}
