import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { buildCacheRoot, CcCompileError, compileC, compileLibArchive, executableNativeEnvironmentFingerprint, mobileLibraryTarget, mobileTargetRefusal, prepareBuildCacheRoot, pruneBuildCache, resolveCc, targetPlatform } from "./backend/cc.js";
import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule, LlvmUnsupportedError } from "./backend/llvm/emitter.js";
import { splitLlvmLibraryProgram, splitLlvmProgram } from "./backend/llvm/split.js";
import { rebaseLibrarySourceComments, replaceLibraryIdentity, stripLibraryIdentity, stripLibrarySourceComments } from "./backend/library-identity.js";
import { checkerPanicDiag, ffiNativeBuildDiag, libAsyncExportDiag, libAsyncSurfaceDiag, libExportUnresolvedDiag, libGenericExportDiag, libIntBoundaryDiag, libNpmIneligibleDiag, libSidecarDiag, libUnmappableSignatureDiag, iceDiag, isCheckerPanic, LIB_INBOUND_BYTES_TRAP_CODE, LIB_RUNTIME_TRAP_CODES, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { checkLibraryIntegerSlots, classSeed, hasIntSlots, numberCarrierKind, type FnIntSlots, type IntSlotConfig } from "./library/int-infer.js";
import { loadLibraryProfile, profileRemediation, profileTeaching, type LibraryProfile } from "./library/profile.js";
import { decorateLibraryRefusals, evaluateLibraryFences } from "./library/fence-eval.js";
import { assembleTrapTeaching } from "./library/trap-teaching.js";
import {
  buildSidecar,
  canonicalModuleGraph,
  canonicalPath,
  compilerReleaseVersion,
  libraryIdentityHashes,
  updateSidecarIdentity,
  type SidecarIntegerSlotFacts,
  type SidecarIrRecordPattern,
  type SidecarIrTypePattern,
} from "./library/sidecar.js";
import { validateSidecar } from "./library/sidecar-validate.js";
import { entryFunctionExports, type EntryExportInfo } from "./frontend/lib-exports.js";
import { entryContractFacts, type ContractFacts } from "./frontend/lib-contract.js";
import { moduleLibAsyncSurface, moduleLibNondeterministicSurface, moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleUsesAssert, moduleUsesCopying, moduleUsesDc, moduleUsesDgram, moduleUsesDynAsync, moduleUsesDynInvoke, moduleUsesEmitter, moduleUsesFetch, moduleUsesFileHandle, moduleUsesFsWatch, moduleUsesHttp2, moduleUsesHttpServer, moduleUsesInspect, moduleUsesLegacyTextDecoder, moduleUsesNet, moduleUsesNodeTest, moduleUsesParseArgs, moduleUsesProcessEvents, moduleUsesQs, moduleUsesRegex, moduleUsesSearchParams, moduleUsesStream, moduleUsesSymbol, moduleUsesTls, moduleUsesTlsCa, moduleUsesZlib, type IrFfiImport, type IrLibSection, type IrModule, type IrRecordShape, type IrType, type SrcLoc } from "./ir/nodes.js";
import { serializeModule } from "./ir/serialize.js";
import { validateModule } from "./ir/validate.js";
import { canonicalBuiltinModule, checkPreflight, isNodeTypesPath, loadProgram, locOf, requiresOf, resolveNpmImport, type LoadResult } from "./frontend/program.js";
import { npmStaticIneligibleReason, npmStaticOffenders, npmStaticPackageOfPath } from "./frontend/npm-static.js";
import { provenanceSources } from "./frontend/provenance-registry.js";
import { clearResolveCaches, resolveBareModule } from "./frontend/resolve.js";
import { isJsSourceFileName, isRelativeSpecifier } from "./frontend/shared.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./frontend/lowering/lowerer.js";
import type { CoverageInput, NpmStaticStatus } from "./coverage/report.js";
import { loadFfiProfile, type FfiProfile } from "./ffi/profile.js";
import { hasForeignFfiCallback } from "./backend/ffi-callbacks.js";
import { FrontendInputTracker, trackedReadFile } from "./frontend/input-tracker.js";
import { libraryFrontendImplementationFingerprint, publishEarlyLibraryCache, readEarlyLibraryCache, readSemanticLibraryCache, type EarlyLibraryCacheOptions, type EarlyLibraryCachePublish, type EarlyLibraryNativeFeatures, type SemanticLibraryCacheHit } from "./library/early-cache.js";
import { createSourceLineRebaser } from "./library/semantic-source.js";
import { publishEarlyExecutableCache, publishEarlyExecutableRoute, readEarlyExecutableCache, type EarlyExecutableCacheOptions, type EarlyExecutableNativeFeatures } from "./executable/early-cache.js";
import { compilerImplementationIdentity } from "./library/implementation-identity.js";

export const VERSION = "0.0.1";

export {
  compileC,
  runtimeSrcDir,
  warmNativeCaches,
  type CcOptions,
  type NativeCacheWarmProfile,
  type WarmNativeCachesOptions,
  type WarmNativeCachesResult,
} from "./backend/cc.js";
export { ANDROID_MIN_API, IPHONEOS_MIN_VERSION, isAndroidTarget, isIosTarget, isMobileTarget, mobileLibraryTarget, mobileTargetRefusal } from "./backend/cc.js";
export { emitModule, type CEmitOptions } from "./backend/emission/emitter.js";
export type { ScrDiagnostic } from "./diagnostics/diagnostic.js";
export { renderAll, renderDiagnostic } from "./diagnostics/render.js";
export { renderCoverage, type CoverageInput } from "./coverage/report.js";
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
export { LIB_FN_SIGS, validateModule } from "./ir/validate.js";
export { resolveLibraryFences, type LibraryFenceDecl, type ResolvedLibraryFence } from "./library/fence-eval.js";
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
} from "./library/profile.js";
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
} from "./ffi/profile.js";
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
export { BUILD_ID_SEED, SOURCE_HASH_SEED, hex16, lengthPrefixedStream, wyhash64 } from "./library/wyhash.js";
export { ISLAND_SURFACE, type IslandFnEntry } from "./frontend/lowering/surfaces.js";
export { ambientDtsPath, isExactExternalTypeSpecifier, overridesDtsPath } from "./frontend/program.js";
export { resolveProvenanceSources } from "./frontend/provenance.js";
export { wasiGuestPath, type HostPathFlavor } from "./wasi-paths.js";
export {
  setProvenanceSources,
  type ProvenancePackageSource,
  type ProvenanceSources,
} from "./frontend/provenance-registry.js";
export * as ir from "./ir/nodes.js";

export interface CompileOptions {
  /** Output executable path. Default: <outDir>/<stem>. */
  outPath: string;
  /** Where intermediates (program.c, program.ir.json) land. */
  outDir: string;
  emitIr?: boolean;
  sanitize?: boolean;
  /** Embed the dynamic-island engine (--dynamic). Off = the static default:
   * island constructs are diagnostics and nothing about codegen or linking
   * changes. */
  dynamic?: boolean;
  /** Code generator for the program TU. Unset (the release default): the
   * LLVM backend emits LLVM IR text (.ll) that rides the SAME clang
   * command line in the program-TU seat, and a program outside the LLVM
   * tier falls back to the debugging C backend transparently — the IR is
   * backend-agnostic, so only the emit retries; CompileResult records the
   * lane (`backend`, plus `llvmRefusal` when the fallback engaged). ONLY a
   * tier refusal (LlvmUnsupportedError) falls back — every real diagnostic
   * and every ICE fails the build on either lane. Explicit `llvm` is the
   * debugging/CI pin and keeps the fail-loudly contract: an out-of-tier
   * program is diagnostic SC3001 naming the first unsupported construct,
   * never a silent lane change. Explicit `c` pins the debugging C backend.
   * wasm32-wasi is a production LLVM target and never takes the automatic
   * C fallback; a missing LLVM lowering there is SC3001. */
  backend?: "c" | "llvm";
  /** Native optimization posture. Release is the shipped -O2 default; dev
   * uses -O0 and stable multi-TU object caching for large LLVM programs. */
  optimization?: "release" | "dev";
  /** --npm-static: package names whose shipped, unminified JS compiles
   * STATICALLY as program modules (inference types the bodies; statements
   * the lowering cannot prove become runtime fences). "auto" opts in every
   * directly-imported package passing the eligibility heuristics (own
   * .d.ts, unminified JS, no build-transform markers). A package whose
   * preflight refuses marks itself an offender and falls back to the
   * island (--dynamic) or the requires-dynamic diagnostic (static builds)
   * — never a silent misbuild. Off by default: nothing changes without
   * the flag. */
  npmStatic?: readonly string[] | "auto";
  /** Outbound native FFI manifest. Its signature-only TypeScript bindings
   * lower to direct C ABI calls, and its archive/system-library inputs are
   * appended to the executable link. */
  ffiProfilePath?: string;
}

export type CompileResult =
  /** `cPath` is the generated program TU next to the binary: the .ll under
   * the LLVM backend (the default lane), the .c under the C backend (same
   * seat, same lifecycle — --keep-c in the CLI governs both). `backend` is
   * the code generator that ACTUALLY emitted the TU; `llvmRefusal` is
   * present iff the default lane fell back to C, carrying the tier
   * refusal's machine-readable kind tag ("stmt:...", "libCall:...", ...). */
  | { ok: true; binaryPath: string; cPath: string; irPath?: string; backend: "c" | "llvm"; llvmRefusal?: string }
  | { ok: false; diagnostics: ScrDiagnostic[]; sourceTexts: Map<string, string> };

/** The LLVM backend's tier refusal as a diagnostic. SC3xxx = backend
 * coverage (the program is fine — this backend doesn't compile it yet);
 * the parenthesized kind tag is machine-readable for the differential
 * harness's histogram. */
function llvmRefusalDiag(err: LlvmUnsupportedError, entryPath: string): ScrDiagnostic {
  return {
    code: "SC3001",
    message: err.message,
    loc: err.loc ?? { file: entryPath, start: 0, end: 0 },
  };
}

/** A valid IR surface the explicitly-selected code generator cannot host.
 * SC3001 is backend coverage (as with an LLVM tier refusal), not a target
 * capability gap: wasm32-wasi's production LLVM lane still accepts it. */
function backendRefusalDiag(
  backend: "c" | "llvm",
  target: string,
  surface: string,
  loc: SrcLoc,
): ScrDiagnostic {
  return {
    code: "SC3001",
    message: `${backend} backend does not support ${surface} for ${target}; use --backend llvm`,
    loc,
  };
}

/** A valid program surface that the selected execution target cannot host.
 * SC3xxx stays the backend/target-coverage family: source semantics are
 * valid, but this target deliberately refuses them instead of emitting a
 * binary that traps later. */
function targetRefusalDiag(target: string, surface: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC3002",
    message: `${target} target does not support ${surface}`,
    loc,
  };
}

/** APIs that require host capabilities absent from portable WASI Preview 1.
 * These are target diagnostics, not backend-tier gaps: the same language IR
 * (including async, generators, and the dynamic island) is otherwise valid.
 * Keep the fine-grained walk first so diagnostics point at the API use; the
 * embedded-module checks are the entry-anchored safety net for island code. */
function moduleWasiUnavailableSurface(mod: IrModule): { surface: string; loc: SrcLoc } | null {
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const prefixes: readonly (readonly [string, string])[] = [
    ["cp.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["child.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["net.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http.", "network sockets (WASI Preview 1 has no socket API)"],
    ["https.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["h2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgram.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dns.", "network sockets (WASI Preview 1 has no socket API)"],
    ["tls.", "network sockets (WASI Preview 1 has no socket API)"],
    ["fetch.", "network-backed fetch (WASI Preview 1 has no socket API)"],
    ["fs.watch", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["watcher.", "filesystem watching (WASI Preview 1 has no notification API)"],
  ];
  const kinds: ReadonlyMap<string, string> = new Map([
    ["child", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["childStream", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["netServer", "network sockets (WASI Preview 1 has no socket API)"],
    ["netSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Session", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Stream", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgramSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["fsWatcher", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["httpReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpRes", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpClientReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["secureCtx", "network sockets (WASI Preview 1 has no socket API)"],
  ]);
  let found: { surface: string; loc: SrcLoc } | null = null;
  const visit = (value: unknown, inheritedLoc: SrcLoc): void => {
    if (found !== null || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedLoc);
      return;
    }
    const node = value as { kind?: unknown; fn?: unknown; loc?: SrcLoc };
    const loc = node.loc ?? inheritedLoc;
    if (typeof node.kind === "string") {
      const kindSurface = kinds.get(node.kind);
      if (kindSurface !== undefined) {
        found = { surface: kindSurface, loc };
        return;
      }
      if (node.kind === "libCall" && typeof node.fn === "string") {
        if (node.fn === "process.kill" || node.fn === "process.killNum" ||
            node.fn === "process.onSignal" || node.fn === "process.offSignal") {
          found = { surface: "OS signals (WASI Preview 1 has no signal API)", loc };
          return;
        }
        if (node.fn === "os.networkInterfaces") {
          found = { surface: "network-interface enumeration (WASI Preview 1 has no interface API)", loc };
          return;
        }
        for (const [prefix, surface] of prefixes) {
          if (node.fn.startsWith(prefix)) {
            found = { surface, loc };
            return;
          }
        }
      }
    }
    for (const key of Object.keys(value)) {
      visit((value as Record<string, unknown>)[key], loc);
    }
  };
  visit(mod, entryLoc);
  if (found !== null) return found;

  if (moduleUsesFetch(mod)) {
    return { surface: "network-backed fetch (WASI Preview 1 has no socket API)", loc: entryLoc };
  }
  for (const builtin of ["node:http", "node:https", "node:net", "node:tls"] as const) {
    if (moduleEmbedsBuiltin(mod, builtin)) {
      return { surface: `${builtin} networking (WASI Preview 1 has no socket API)`, loc: entryLoc };
    }
  }
  return null;
}

/** Clang may print every warning from the generated/runtime translation
 * units before the actionable linker failure. Keep the source diagnostic
 * precise by starting at the first portable linker marker; if the driver
 * supplied no recognizable marker, retain only its bounded tail. */
function ffiNativeBuildDetail(err: CcCompileError): string {
  const lines = err.stderr.trim().split(/\r?\n/);
  const linkerMarker = lines.findIndex((line) =>
    /(?:Undefined symbols|undefined reference to|unresolved external symbol|duplicate symbol|library not found for|cannot find -l|unable to find library|file format not recognized|linker command failed|fatal error LNK|lld-link: error)/i.test(line)
  );
  const relevant = linkerMarker >= 0 ? lines.slice(linkerMarker) : lines.slice(-40);
  const output = relevant.join("\n").trim();
  return (
    `${err.driver} ${linkerMarker >= 0 ? "could not link the generated program" : "failed while building the generated program"}` +
    (output.length > 0 ? `:\n${output}` : "")
  );
}

export interface AnalyzeResult {
  coverage: CoverageInput;
  sourceTexts: Map<string, string>;
}

/** The platform the BUILD is for — the SCRIPTC_TARGET triple's OS under a
 * cross compile, the host's otherwise. The frontend needs it too (the
 * whole program compiles for ONE platform, so path.sep / os.EOL literals
 * and the path-module binding are compile-time constants); a malformed
 * SCRIPTC_CC/SCRIPTC_TARGET combination reports at compileC exactly as
 * before, so analysis falls back to the host here rather than throwing. */
export function buildTargetPlatform(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return targetPlatform(resolveCc(env));
  } catch {
    return process.platform;
  }
}

export interface AnalyzeOptions {
  /** Analyze as a --dynamic build (island constructs lower instead of
   * producing requires-dynamic diagnostics). */
  dynamic?: boolean;
  /** --npm-static (see CompileOptions.npmStatic): the analysis compiles
   * opted-in packages' JS as program modules and the coverage report
   * carries each package's static/fallback status. */
  npmStatic?: readonly string[] | "auto";
  /** Analyze with the outbound native bindings from this FFI manifest. */
  ffiProfilePath?: string;
  /** Coverage-only external host type surfaces: exact bare module
   * specifier → local declaration file. The checker uses the declarations
   * to analyze project code, but imported runtime values remain explicit
   * SC1010 blockers rather than being counted as executable. */
  externalTypes?: Readonly<Record<string, string>>;
}

/* ── the frontend, one pipeline shape ───────────────────────────────────
 * Load → preflight → lowering all ride the ONE tsgo program (program.ts +
 * lowering/ over the ts7 adapter) — the native TypeScript compiler is the
 * only frontend since the phase-4 flip retired the 5.9.3 pipeline
 * (typescript@5.9.3 survives solely as the sanctioned islands: npm.ts's
 * parse scan and lower-comptime's transpileModule). Everything after
 * lowering is IR-world, so analyze() and compile() consume this one
 * Frontend shape. */
interface Frontend {
  preflight: ScrDiagnostic[];
  /** The entry source file's text (emitModule's header comment input). */
  entryText: () => string;
  /** Library mode's resolution input: the entry file's exported function
   * declarations (call before dispose — it reads the ts7 AST). */
  entryExports: () => Map<string, EntryExportInfo>;
  /** The contract sidecar's projection input: the entry file's exported
   * function signatures and convention consts, plus the whole graph's
   * exported type declarations, in declaration order (call before
   * dispose — it reads the ts7 AST). */
  entryContract: () => ContractFacts;
  sourceTexts: () => Map<string, string>;
  lower: (opts: LowerOptions) => LowerResult;
  /** --npm-static: each requested (or auto-detected) package's outcome —
   * compiled statically, or fallen back with the first refusal reason. */
  npmStatic: NpmStaticStatus[];
  /** Library mode only (empty otherwise): each judged npm package's first
   * import site, the anchor for the SC4020 static-or-refuse teaching. */
  npmImportSites: ReadonlyMap<string, SrcLoc>;
  /** Releases the frontend's resources (the spawned tsgo server). Call
   * exactly once, after the last lower(). */
  dispose: () => void;
}

/** --npm-static=auto (and library mode's mandatory twin): one throwaway
 * load finds every bare npm import the program's own modules make, then
 * the eligibility heuristics (npm-static.ts) pick the packages whose
 * shipped JS is worth attempting. Rejected candidates report their reason
 * so the coverage output says why auto skipped them.
 *
 * "lib" widens the scan to the STATIC-OR-REFUSE posture (a fallback
 * status is a build-stopping SC4020 there, never an island note):
 *   - opted-in packages' OWN files are scanned too — import statements
 *     and top-level requires alike — so runFrontend's fixpoint loop
 *     judges every bare edge the growing graph exposes (the executable
 *     lane leaves a package's deps to the island; the library lane has
 *     no island);
 *   - a bare specifier no TYPES resolution answers but whose runtime JS
 *     resolves (a package with no own .d.ts) is judged instead of
 *     skipped — it fails the bar by name, not as a generic import fence;
 *   - `judged` dedups across fixpoint iterations and `sites` records
 *     each package's first import site, the SC4020 anchor. */
function detectAutoPackages(
  load: LoadResult,
  statuses: NpmStaticStatus[],
  mode: "auto" | "lib" = "auto",
  judged?: Set<string>,
  sites?: Map<string, SrcLoc>,
): string[] {
  // package → the resolved types file AND the file whose import found it:
  // the runtime-JS probe below must resolve from the SAME importing file,
  // or a package visible only to a nested package.json realm (a pnpm
  // monorepo's packages/*/node_modules, unreachable from the entry's own
  // walk-up) answers "no runtime JS" for perfectly ordinary installs.
  const seen = new Map<string, { typesFile: string; fromFile: string }>();
  for (const sf of [...load.moduleOrder, load.entry]) {
    if (mode === "auto" && sf.fileName.includes("/node_modules/")) continue;
    const edges: { spec: string; loc: SrcLoc }[] = [];
    for (const stmt of sf.statements) {
      if (ts7IsImportWithStringSpec(stmt)) {
        edges.push({ spec: (stmt as { moduleSpecifier: { text: string } }).moduleSpecifier.text, loc: locOf(stmt) });
      } else if (mode === "lib") {
        // CJS packages spell their dep edges as top-level requires; the
        // import-statement scan alone would miss every one of them.
        for (const req of requiresOf(stmt)) edges.push({ spec: req.spec, loc: locOf(req.node) });
      }
    }
    for (const { spec, loc } of edges) {
      if (isRelativeSpecifier(spec) || spec.startsWith("node:") || spec.startsWith("#")) continue;
      // Bare builtin names ("fs", "path") are the builtin machinery's
      // business (and the SC4005 async_free gate's, in library mode) —
      // never npm candidates. Auto keeps its original path (the
      // @types/node answer skips them below), byte-for-byte.
      if (mode === "lib" && canonicalBuiltinModule(spec) !== null) continue;
      const npm = resolveNpmImport(sf.fileName, spec);
      if (npm !== null && isNodeTypesPath(npm.typesFile)) continue;
      if (npm === null) {
        if (mode !== "lib") continue;
        const js = resolveBareModule(sf.fileName, spec, "js-only");
        if (js === null || judged!.has(js.packageName)) continue;
        judged!.add(js.packageName);
        sites!.set(js.packageName, loc);
        statuses.push({ package: js.packageName, status: "fallback", detail: "it ships no own .d.ts declaration surface" });
        continue;
      }
      if (judged?.has(npm.packageName)) continue;
      if (!seen.has(npm.packageName)) {
        seen.set(npm.packageName, { typesFile: npm.typesFile, fromFile: sf.fileName });
        sites?.set(npm.packageName, loc);
      }
    }
  }
  const chosen: string[] = [];
  for (const [pkg, { typesFile, fromFile }] of seen) {
    judged?.add(pkg);
    const jsEntry = resolveBareModule(fromFile, pkg, "js-only");
    const reason = npmStaticIneligibleReason(
      pkg,
      typesFile,
      jsEntry !== null && isJsSourceFileName(jsEntry.typesFile) ? jsEntry.typesFile : null,
    );
    if (reason === null) chosen.push(pkg);
    else statuses.push({ package: pkg, status: "fallback", detail: mode === "lib" ? reason : `auto: ${reason}` });
  }
  return chosen;
}

/** Duck-typed import-declaration test (the ts7 AST types stay inside the
 * frontend; this file only needs the specifier text). */
function ts7IsImportWithStringSpec(stmt: unknown): stmt is { moduleSpecifier: { text: string } } {
  const s = stmt as { kind?: unknown; moduleSpecifier?: { text?: unknown } };
  return typeof s.moduleSpecifier?.text === "string";
}

/** The opted-in packages a consumer-anchored tsc message NAMES: module
 * specifiers in `Module '"spec"'` phrasings, and resolved file paths in
 * `import("…")` type spellings — the two ways the checker points at an
 * import surface from the importer's side. */
function packagesNamedByDiag(message: string, optedIn: ReadonlySet<string>): Set<string> {
  const hits = new Set<string>();
  for (const m of message.matchAll(/Module '"([^"]+)"'/g)) {
    const spec = m[1]!;
    const parts = spec.split("/");
    const prefix = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (optedIn.has(prefix)) hits.add(prefix);
  }
  for (const m of message.matchAll(/import\("([^"]+)"\)/g)) {
    const pkg = npmStaticPackageOfPath(m[1]!);
    if (pkg !== null && optedIn.has(pkg)) hits.add(pkg);
  }
  return hits;
}

/** The package-wide --npm-static name containing an exact bare specifier.
 * External mappings are exact (subpaths included), while npm-static owns a
 * whole package, so any mapped subpath conflicts with that package opt-in. */
function packageNameOfBareSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The one frontend, three npm postures: `undefined`/explicit package
 * lists and `"auto"` are the executable lane's (--npm-static; fallback =
 * island). `"lib"` is library mode's mandatory auto twin — the same
 * eligibility bar and the same opt-in machinery, but every fallback
 * status the shared loops record becomes compileLibrary's SC4020
 * static-or-refuse teaching, and the detection closes over the opted-in
 * packages' own bare edges (no island exists to serve a dep from). */
function runFrontend(
  entryPath: string,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
): Frontend {
  // Resolver package/workspace metadata is intentionally shared across the
  // several load attempts of ONE auto-detection fixpoint, but never across
  // separate compiles in a long-lived process.  A cache miss must observe
  // package.json edits before it can publish a new early-library entry.
  clearResolveCaches();
  const statuses: NpmStaticStatus[] = [];
  const npmSites = new Map<string, SrcLoc>();
  const judged = new Set<string>();
  let requested: string[] = [];
  let reusableScout: ReturnType<typeof loadProgram> | null = null;
  let reusablePreflight: ScrDiagnostic[] | null = null;
  if (npmStatic === "auto" || npmStatic === "lib") {
    const scout = loadProgram(entryPath, { externalTypes });
    let retained = false;
    try {
      const scoutPreflight = checkPreflight(scout);
      requested =
        npmStatic === "lib"
          ? detectAutoPackages(scout, statuses, "lib", judged, npmSites)
          : detectAutoPackages(scout, statuses);
      // With no package to opt in, the scout already IS the final frontend:
      // same roots, resolution posture, preflight, and module order. Retain it
      // instead of spawning a second tsgo server and checking the whole graph
      // again — the common library-mode path has no bare npm imports.
      if (requested.length === 0) {
        reusableScout = scout;
        reusablePreflight = scoutPreflight;
        retained = true;
      }
    } finally {
      if (!retained) scout.dispose();
    }
  } else if (npmStatic !== undefined) {
    requested = [...new Set(npmStatic)];
  }

  // One exact --external-types mapping makes the containing package an
  // external host boundary, which cannot simultaneously be compiled as a
  // package-wide --npm-static program graph. External wins; retain the
  // ordinary npm-static fallback record so explicit and auto requests both
  // explain why the package did not compile statically.
  if (requested.length > 0 && externalTypes !== undefined) {
    const externalSpecifiersByPackage = new Map<string, string[]>();
    for (const specifier of Object.keys(externalTypes)) {
      const pkg = packageNameOfBareSpecifier(specifier);
      const specs = externalSpecifiersByPackage.get(pkg) ?? [];
      specs.push(specifier);
      externalSpecifiersByPackage.set(pkg, specs);
    }
    requested = requested.filter((pkg) => {
      const specs = externalSpecifiersByPackage.get(pkg);
      if (specs === undefined) return true;
      statuses.push({
        package: pkg,
        status: "fallback",
        detail: `mapped as an external host module by --external-types (${specs.map((s) => JSON.stringify(s)).join(", ")})`,
      });
      return false;
    });
  }

  // The all-or-nothing fallback loop: a preflight diagnostic ANCHORED in
  // an opted-in package's files (an unsupported require form, a builtin
  // fence) — or an offender the resolution itself reported — drops that
  // package from the set and the whole frontend reloads without it, so
  // its import takes the ordinary island path. Static compilation of a
  // package must never turn a working --dynamic build into a build
  // failure.
  //
  // CONSUMER-anchored attribution (the second source): an opted-in
  // package whose inferred export surface breaks the typecheck reports at
  // its IMPORT SITES — errors in program files no path-shaped attribution
  // reaches, but whose MESSAGES name the package ("Module '"pkg"' has no
  // exported member", "typeof import("…/pkg/dist/index")"). Bundle-shaped
  // dists carry surfaces inference can only partly reach (type-only
  // re-exports have no JS value to chase), and the ratified behavior is
  // graceful PER-PACKAGE degradation: the named package drops to the
  // island with a note, never a failed gate. Explicit opt-ins degrade
  // exactly like auto's — "the user asked for these packages" buys the
  // attempt, not a broken build.
  let load = reusableScout ?? loadProgram(entryPath, { npmStatic: requested, externalTypes });
  let preflight = reusablePreflight ?? checkPreflight(load);
  // Library mode's fixpoint: the opted-in packages' files joined the
  // program just now, and THEIR bare edges (import statements and
  // top-level requires) name packages the scout could not see. Judge each
  // by the same bar — eligible ones join the set and the frontend
  // reloads; ineligible ones record the fallback status compileLibrary
  // refuses on. Bounded by the dependency count (every iteration settles
  // at least one new package for good).
  if (npmStatic === "lib") {
    for (;;) {
      const grown = detectAutoPackages(load, statuses, "lib", judged, npmSites);
      if (grown.length === 0) break;
      requested = [...requested, ...grown];
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: requested, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  const effective = new Set(requested);
  while (effective.size > 0) {
    const reasons = new Map<string, string>(npmStaticOffenders());
    for (const d of preflight) {
      const pkg = npmStaticPackageOfPath(d.loc.file);
      if (pkg !== null && !reasons.has(pkg)) reasons.set(pkg, `${d.code}: ${d.message}`);
    }
    if (![...reasons.keys()].some((p) => effective.has(p))) {
      const named = new Map<string, number>();
      for (const d of preflight) {
        if (d.code !== "SC0001") continue;
        for (const pkg of packagesNamedByDiag(d.message, effective)) {
          named.set(pkg, (named.get(pkg) ?? 0) + 1);
        }
      }
      for (const [pkg, count] of named) {
        reasons.set(
          pkg,
          `its inferred export surface breaks ${count} import site${count === 1 ? "" : "s"} in program files${npmStatic === "lib" ? "" : " — the package serves from the island instead"} (bundler-emitted surfaces type only as far as inference reaches)`,
        );
      }
    }
    const dropping = [...reasons.keys()].filter((p) => effective.has(p));
    if (dropping.length === 0) break;
    for (const p of dropping) {
      effective.delete(p);
      statuses.push({ package: p, status: "fallback", detail: reasons.get(p)! });
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: effective, externalTypes });
    preflight = checkPreflight(load);
  }
  // The last resort, ALL modes: an opt-in can change the PROGRAM's OWN
  // typecheck through errors that name no package at all (the inferred
  // surface replaces the shipped .d.ts — the commander name()/description()
  // chaining shape, or a .d.ts type-GUARD an inferred JS function cannot
  // reproduce, so every catch-clause narrowing site reports "'err' is of
  // type 'unknown'"). Those SC0001s anchor in USER files no offender or
  // message attribution reaches, so each remaining package is probed
  // ALONE-dropped (n is the opt-in count — a handful of extra analysis
  // loads); culprits whose removal clears the errors fall back with a
  // note, and if no subset typechecks, everything drops. Explicit opt-ins
  // degrade the same way — the ratified stance for bundle-shaped dists is
  // graceful per-package degradation, never a failed gate the user cannot
  // act on (the note carries the why).
  if (effective.size > 0 && preflight.some((d) => d.code === "SC0001")) {
    const dropWithNote = (p: string): void => {
      effective.delete(p);
      statuses.push({
        package: p,
        status: "fallback",
        detail:
          npmStatic === "auto"
            ? "auto: the program does not typecheck against its inferred surface"
            : npmStatic === "lib"
              ? "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase)"
              : "the program does not typecheck against its inferred surface (type-only declarations and .d.ts type guards have no JS value inference can chase) — the package serves from the island instead",
      });
    };
    // Attribute per package by probing each SOLO (culprits are almost
    // always independent — each package's inferred surface breaks its own
    // import sites), then reload with the survivors; interaction effects
    // that still fail drop everything left.
    for (const p of [...effective]) {
      const probe = loadProgram(entryPath, { npmStatic: [p], externalTypes });
      const probeDiags = checkPreflight(probe);
      probe.dispose();
      if (probeDiags.some((d) => d.code === "SC0001")) dropWithNote(p);
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: effective, externalTypes });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: effective, externalTypes });
      preflight = checkPreflight(load);
    }
  }
  for (const p of requested) {
    if (effective.has(p)) statuses.push({ package: p, status: "static" });
  }

  const finalLoad = load;
  return {
    preflight,
    entryText: () => finalLoad.entry.text,
    entryExports: () => entryFunctionExports(finalLoad.entry),
    // The contract scans the PROGRAM's source files, not the runtime
    // module order: a type-only module (nothing but exported types) has no
    // runtime edge and never joins moduleOrder, yet its declarations are
    // contract surface. Declaration files (default libs, @types) stay out,
    // and so do statically-compiled npm packages' files: their .d.ts is
    // dropped by construction (inference types the bodies), so no npm
    // declaration can name a wire-contract type — the contract vocabulary
    // is authored program surface only, and a workspace-linked package's
    // shipped .ts must not smuggle same-name declarations into the type
    // table.
    entryContract: () =>
      entryContractFacts(
        finalLoad.entry,
        finalLoad.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && npmStaticPackageOfPath(sf.fileName) === null),
      ),
    // Runtime evaluation order first, then any type-only program modules
    // (no runtime edge, so absent from moduleOrder — but they are contract
    // surface now, and the library identity hashes cover the WHOLE module
    // graph; the Map dedups by fileName). Statically-compiled npm modules
    // are in moduleOrder like any program module, so their bytes join the
    // library identity hashes (source_hash/build_id) — compiled code is
    // identity, whatever directory it came from.
    sourceTexts: () =>
      new Map<string, string>(
        [finalLoad.entry, ...finalLoad.moduleOrder, ...finalLoad.program.getSourceFiles().filter((sf) => !sf.isDeclarationFile)].map(
          (sf) => [sf.fileName, sf.text],
        ),
      ),
    lower: (opts) => lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, {
      ...opts,
      startupCrash: finalLoad.startupCrash ?? null,
      externalTypes: finalLoad.externalTypes,
      externalTypeSpecifiersByFile: finalLoad.externalTypeSpecifiersByFile,
    }),
    npmStatic: statuses,
    npmImportSites: npmSites,
    dispose: finalLoad.dispose,
  };
}

/** Analysis without codegen: how much of the program compiles statically.
 * Unlike compile(), lowering diagnostics are data here, not failure. */
export function analyze(entryPath: string, opts: AnalyzeOptions = {}): AnalyzeResult {
  let ffi: FfiProfile | null = null;
  if (opts.ffiProfilePath !== undefined) {
    const loaded = loadFfiProfile(opts.ffiProfilePath);
    if (!loaded.ok) {
      return {
        coverage: {
          file: entryPath,
          dynamic: opts.dynamic ?? false,
          stats: { statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 },
          diagnostics: loaded.diagnostics,
          preflightFailed: true,
        },
        sourceTexts: new Map(),
      };
    }
    ffi = loaded.profile;
  }
  const fe = runFrontend(entryPath, opts.npmStatic, opts.externalTypes);
  try {
    const emptyStats = { statementsTotal: 0, statementsFailed: 0, statementsIsland: 0, functionsSkipped: 0 };

    const preflight = fe.preflight;
    // Import-FORM fences don't stop the analysis: the module graph is still
    // computable (a fenced import contributes no edges), the imported
    // bindings poison at their use sites, and the fences join the blockers
    // list beside statement-level ones — the report shows a statement
    // percentage instead of stopping at the import lines. Everything else —
    // tsc errors, config incompatibilities, circular imports — still stops
    // at preflight (no trustworthy program to lower). Builds are unchanged:
    // compile() fails on every preflight diagnostic exactly as before.
    const IMPORT_FENCES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015"]);
    if (preflight.some((d) => !IMPORT_FENCES.has(d.code))) {
      return {
        coverage: {
          file: entryPath,
          dynamic: opts.dynamic ?? false,
          stats: emptyStats,
          diagnostics: preflight,
          ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
          preflightFailed: true,
        },
        sourceTexts: fe.sourceTexts(),
      };
    }
    // Coverage is whole-program by design: builds stop at what the entry
    // reaches, but the analysis additionally lowers the unreached remainder
    // (throwaway) so the report covers everything the source declares — with
    // the unreached share in its own group.
    const lowered = fe.lower({
      dynamic: opts.dynamic ?? false,
      coverage: true,
      targetPlatform: buildTargetPlatform(),
      ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
    });
    const provenance = provenanceSources();
    return {
      coverage: {
        file: entryPath,
        dynamic: opts.dynamic ?? false,
        stats: lowered.stats,
        // The import fences report as blockers alongside the statement-level
        // ones (use sites of the fenced bindings emit matching diagnostics,
        // which the report groups with these).
        diagnostics: [...preflight, ...lowered.diagnostics],
        ...(lowered.runtimeFences.length > 0 ? { runtimeFences: lowered.runtimeFences } : {}),
        ...(lowered.unreached ? { unreached: lowered.unreached } : {}),
        ...(lowered.npmBuiltins ? { npmBuiltins: lowered.npmBuiltins } : {}),
        ...(lowered.npmLazyTraps ? { npmLazyTraps: lowered.npmLazyTraps } : {}),
        ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
        // --provenance-sources: the per-package attribution inputs (the
        // report aggregates statsByFile under each package's source dir).
        ...(provenance !== null ? { provenance } : {}),
        ...(lowered.statsByFile ? { statsByFile: lowered.statsByFile } : {}),
        ...(lowered.provenanceElided ? { provenanceElided: lowered.provenanceElided } : {}),
        preflightFailed: false,
      },
      sourceTexts: fe.sourceTexts(),
    };
  } finally {
    fe.dispose();
  }
}

/** The whole pipeline: load → preflight → lower → validate → emit C → clang. */
export async function compile(entryPath: string, opts: CompileOptions): Promise<CompileResult> {
  const frontendInputs = new FrontendInputTracker();
  return frontendInputs.run(() => compileTracked(entryPath, opts, frontendInputs));
}

function executableNativeFeatures(
  mod: IrModule,
  backend: "c" | "llvm",
  dynamic: boolean,
  optimization: "release" | "dev",
  llvmRefusal?: string,
): EarlyExecutableNativeFeatures {
  return {
    backend,
    ...(optimization === "dev" ? { optimization: "dev" as const } : {}),
    ...(llvmRefusal === undefined ? {} : { llvmRefusal }),
    dynamic,
    regex: moduleUsesRegex(mod),
    copying: moduleUsesCopying(mod),
    textDecoderLegacy: moduleUsesLegacyTextDecoder(mod),
    fileHandle: moduleUsesFileHandle(mod),
    fetch: moduleUsesFetch(mod),
    netIsland:
      moduleEmbedsBuiltin(mod, "node:http") ||
      moduleEmbedsBuiltin(mod, "node:https") ||
      moduleEmbedsBuiltin(mod, "node:net") ||
      moduleEmbedsBuiltin(mod, "node:tls"),
    zlib: moduleUsesZlib(mod) || moduleEmbedsCompressedNpm(mod),
    assert: moduleUsesAssert(mod),
    inspect: moduleUsesInspect(mod),
    dynInvoke: moduleUsesDynInvoke(mod),
    dc: moduleUsesDc(mod),
    dynAsync: moduleUsesDynAsync(mod),
    events: moduleUsesProcessEvents(mod),
    emitter: moduleUsesEmitter(mod),
    symbol: moduleUsesSymbol(mod),
    searchParams: moduleUsesSearchParams(mod),
    qs: moduleUsesQs(mod),
    parseArgs: moduleUsesParseArgs(mod),
    stream: moduleUsesStream(mod),
    net: moduleUsesNet(mod),
    http: moduleUsesHttpServer(mod),
    http2: moduleUsesHttp2(mod),
    dgram: moduleUsesDgram(mod),
    watch: moduleUsesFsWatch(mod),
    foreignFfi: hasForeignFfiCallback(mod.ffiImports ?? []),
    nodeTest: moduleUsesNodeTest(mod),
    tls: moduleUsesTls(mod),
    tlsCa: moduleUsesTlsCa(mod),
  };
}

async function compileExecutableNative(
  features: EarlyExecutableNativeFeatures,
  cPath: string,
  outPath: string,
  sanitize: boolean,
  ffi: FfiProfile | null,
  programSplit: ReturnType<typeof splitLlvmProgram> = null,
  onArtifactReady?: NonNullable<Parameters<typeof compileC>[0]["onArtifactReady"]>,
): Promise<void> {
  const effectiveProgramSplit =
    programSplit ??
    (features.optimization === "dev" && features.backend === "llvm" && !sanitize
      ? splitLlvmProgram(await readFile(cPath, "utf8"))
      : null);
  await compileC({
    cPath,
    outPath,
    cacheIdentity: "scriptc-generated-v1",
    ...(features.optimization === "dev" ? { optimization: "dev" as const } : {}),
    ...(effectiveProgramSplit === null
      ? {}
      : {
          programShards: effectiveProgramSplit.shards,
          programPublicSymbols: effectiveProgramSplit.publicSymbols,
        }),
    sanitize,
    dynamic: features.dynamic,
    regex: features.regex,
    copying: features.copying,
    textDecoderLegacy: features.textDecoderLegacy,
    fileHandle: features.fileHandle,
    fetch: features.fetch,
    netIsland: features.netIsland,
    zlib: features.zlib,
    assert: features.assert,
    inspect: features.inspect,
    dynInvoke: features.dynInvoke,
    dc: features.dc,
    dynAsync: features.dynAsync,
    events: features.events,
    emitter: features.emitter,
    symbol: features.symbol,
    searchParams: features.searchParams,
    qs: features.qs,
    parseArgs: features.parseArgs,
    stream: features.stream,
    net: features.net,
    http: features.http,
    http2: features.http2,
    dgram: features.dgram,
    watch: features.watch,
    foreignFfi: features.foreignFfi,
    nodeTest: features.nodeTest,
    tls: features.tls,
    tlsCa: features.tlsCa,
    ...(onArtifactReady === undefined ? {} : { onArtifactReady }),
    ...(ffi === null
      ? {}
      : { linkInputs: ffi.libraries, systemLibraries: ffi.systemLibraries }),
  });
}

async function compileTracked(
  entryPath: string,
  opts: CompileOptions,
  frontendInputs: FrontendInputTracker,
): Promise<CompileResult> {
  entryPath = resolve(entryPath);
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
  const buildPlatform = buildTargetPlatform();
  // Mobile triples are library-mode targets: the archive an embedding app
  // links is the artifact, and only the library-admissible runtime surface
  // is verified on those device classes. The executable lane refuses before
  // any frontend work — a pure env check, so the refusal needs no toolchain.
  {
    const entryLoc: SrcLoc = { file: entryPath, start: 0, end: 0 };
    const mobileTarget = mobileLibraryTarget();
    if (mobileTarget !== null) {
      return {
        ok: false,
        diagnostics: [
          targetRefusalDiag(
            mobileTarget,
            "standalone executable builds — mobile targets produce library-mode static archives (SCRIPTC_CC=zigcc scriptc build --lib --profile <profile.json>) for an embedding app to link",
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
  const cacheRoot = provenanceSources() === null
    ? await prepareBuildCacheRoot(buildCacheRoot())
    : null;
  const implementation = await compilerImplementationIdentity();
  const earlyCacheOptions: EarlyExecutableCacheOptions = {
    entryPath,
    outDir: opts.outDir,
    outPath: opts.outPath,
    emitIr: opts.emitIr ?? false,
    sanitize: opts.sanitize ?? false,
    dynamic: opts.dynamic ?? false,
    backend: opts.backend ?? "auto",
    ...(opts.optimization === "dev" ? { optimization: "dev" as const } : {}),
    npmStatic: opts.npmStatic ?? null,
    ffiProfile:
      opts.ffiProfilePath === undefined || ffiProfileBytes === null
        ? null
        : { path: opts.ffiProfilePath, bytes: ffiProfileBytes },
    target: `${process.env["SCRIPTC_TARGET"] ?? "native"}:${buildPlatform}:${process.arch}`,
    compiler: [process.env["SCRIPTC_CC"] ?? "clang"],
    nativeEnvironment: await executableNativeEnvironmentFingerprint(),
    nodeVersion: process.version,
    implementation: implementation.digest,
    implementationDependencies: implementation.dependencies,
  };
  const earlyHit = await readEarlyExecutableCache(cacheRoot, earlyCacheOptions);
  if (earlyHit !== null) {
    // Route/proof metadata is independently evictable. A full-compiler
    // fallback that still finds the validated payload repairs that lightweight
    // index so the next identical CLI invocation can avoid this module graph.
    await publishEarlyExecutableRoute(cacheRoot, earlyCacheOptions).catch(() => undefined);
    if (earlyHit.executableRestored) {
      await pruneBuildCache(cacheRoot);
      return {
        ok: true,
        binaryPath: opts.outPath,
        cPath: earlyHit.cPath,
        backend: earlyHit.native.backend,
        ...(earlyHit.irPath === undefined ? {} : { irPath: earlyHit.irPath }),
        ...(earlyHit.native.llvmRefusal === undefined
          ? {}
          : { llvmRefusal: earlyHit.native.llvmRefusal }),
      };
    }
    try {
      await compileExecutableNative(
        earlyHit.native,
        earlyHit.cPath,
        opts.outPath,
        opts.sanitize ?? false,
        ffi,
        null,
        async ({ dependencies }) => {
          await publishEarlyExecutableCache(cacheRoot, earlyCacheOptions, {
            ...earlyHit,
            executableRestored: true,
            nativeDependencies: dependencies,
            frontend: earlyHit.frontend,
          });
        },
      );
    } catch (err) {
      if (ffi !== null && err instanceof CcCompileError) {
        return {
          ok: false,
          diagnostics: [ffiNativeBuildDiag(
            ffiNativeBuildDetail(err),
            opts.ffiProfilePath ?? entryPath,
          )],
          sourceTexts: new Map(),
        };
      }
      throw err;
    }
    await pruneBuildCache(cacheRoot);
    return {
      ok: true,
      binaryPath: opts.outPath,
      cPath: earlyHit.cPath,
      backend: earlyHit.native.backend,
      ...(earlyHit.irPath === undefined ? {} : { irPath: earlyHit.irPath }),
      ...(earlyHit.native.llvmRefusal === undefined
        ? {}
        : { llvmRefusal: earlyHit.native.llvmRefusal }),
    };
  }
  const fe = runFrontend(entryPath, opts.npmStatic);
  let lowered: LowerResult;
  let entryText: string;
  let sourceTexts: Map<string, string>;
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    const fail = (diagnostics: ScrDiagnostic[]): CompileResult => ({
      ok: false,
      diagnostics,
      sourceTexts: fe.sourceTexts(),
    });

    if (fe.preflight.length > 0) return fail(fe.preflight);

    try {
      lowered = fe.lower({
        dynamic: opts.dynamic ?? false,
        targetPlatform: buildPlatform,
        ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
      });
    } catch (e) {
      // The last-resort panic fence: an upstream tsgo panic that crossed a
      // checker call no statement/collection fence wrapped still becomes a
      // clean failed compile (anchored at the entry), never a crashed CLI.
      if (!isCheckerPanic(e)) throw e;
      return fail([
        checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 }),
      ]);
    }
    if (lowered.module === null) return fail(lowered.diagnostics);

    const validation = validateModule(lowered.module);
    if (validation.length > 0) {
      return fail(validation.map((v) => iceDiag(v.message, v.loc)));
    }
    if (buildPlatform === "wasi") {
      const entryLoc: SrcLoc = { file: entryPath, start: 0, end: 0 };
      if (opts.sanitize) {
        return fail([targetRefusalDiag("wasm32-wasi", "--sanitize", entryLoc)]);
      }
      if (ffi !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", "native FFI manifests", entryLoc)]);
      }
      const unavailable = moduleWasiUnavailableSurface(lowered.module);
      if (unavailable !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", unavailable.surface, unavailable.loc)]);
      }
      if (opts.backend === "c") {
        const asyncSurface = moduleLibAsyncSurface(lowered.module);
        if (asyncSurface !== null) {
          return fail([
            backendRefusalDiag("c", "wasm32-wasi", asyncSurface.surface, asyncSurface.loc),
          ]);
        }
      }
    }
    entryText = fe.entryText();
    sourceTexts = fe.sourceTexts();
  } finally {
    fe.dispose();
  }

  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  // Both backends hang off the same in-memory IrModule (never the JSON
  // dump); the LLVM backend's .ll takes the .c's seat on the exact clang
  // command line below — compileC accepts either. The default lane tries
  // LLVM first; a tier refusal retries ONLY the emit with the C backend
  // (the frontend ran once, the IR is backend-agnostic — nothing recompiles).
  let cPath = join(opts.outDir, `${stem}.c`);
  let backend: "c" | "llvm" = "c";
  let llvmSource: string | null = null;
  let llvmRefusal: string | undefined;
  if (opts.backend !== "c") {
    try {
      const ll = emitLlvmModule(lowered.module!, {
        pointerBits: buildPlatform === "wasi" ? 32 : 64,
        wasi: buildPlatform === "wasi",
      });
      cPath = join(opts.outDir, `${stem}.ll`);
      await writeFile(cPath, ll);
      llvmSource = ll;
      backend = "llvm";
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      // Explicit backend "llvm" keeps the fail-loudly contract (the
      // debugging/CI pin): SC3001, never a silent lane change.
      if (opts.backend === "llvm" || buildPlatform === "wasi") {
        return { ok: false, diagnostics: [llvmRefusalDiag(err, entryPath)], sourceTexts };
      }
      llvmRefusal = err.kind;
    }
  }
  if (backend === "c") {
    await writeFile(cPath, emitModule(lowered.module!, entryText));
  }
  // Kept-TU honesty: outDir persists across builds (the CLI's .scriptc/),
  // so a lane change would leave the PREVIOUS lane's TU beside the fresh
  // one — remove the loser so the surviving TU is always the one the
  // binary below was linked from.
  await rm(join(opts.outDir, `${stem}${backend === "llvm" ? ".c" : ".ll"}`), { force: true });

  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.ir.json`);
    await writeFile(irPath, serializeModule(lowered.module));
  }

  const nativeFeatures = executableNativeFeatures(
    lowered.module,
    backend,
    opts.dynamic ?? false,
    opts.optimization ?? "release",
    llvmRefusal,
  );
  const programSplit =
    backend === "llvm" && (opts.optimization ?? "release") === "dev" &&
      !(opts.sanitize ?? false) && llvmSource !== null
      ? splitLlvmProgram(llvmSource)
      : null;
  await mkdir(dirname(opts.outPath), { recursive: true });
  let publishedExecutable = false;
  try {
    await compileExecutableNative(
      nativeFeatures,
      cPath,
      opts.outPath,
      opts.sanitize ?? false,
      ffi,
      programSplit,
      async ({ dependencies }) => {
        await publishEarlyExecutableCache(cacheRoot, earlyCacheOptions, {
          cPath,
          native: nativeFeatures,
          executableRestored: true,
          nativeDependencies: dependencies,
          frontend: frontendInputs.snapshot(),
          ...(irPath === undefined ? {} : { irPath }),
        });
        publishedExecutable = true;
      },
    );
  } catch (err) {
    if (ffi !== null && err instanceof CcCompileError) {
      return {
        ok: false,
        diagnostics: [
          ffiNativeBuildDiag(
            ffiNativeBuildDetail(err),
            opts.ffiProfilePath ?? entryPath,
          ),
        ],
        sourceTexts,
      };
    }
    throw err;
  }
  if (!publishedExecutable) {
    await publishEarlyExecutableCache(cacheRoot, earlyCacheOptions, {
      cPath,
      native: nativeFeatures,
      executableRestored: false,
      frontend: frontendInputs.snapshot(),
      ...(irPath === undefined ? {} : { irPath }),
    }).catch(() => undefined);
  }
  await pruneBuildCache(cacheRoot);
  return {
    ok: true,
    binaryPath: opts.outPath,
    cPath,
    backend,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(llvmRefusal !== undefined ? { llvmRefusal } : {}),
  };
}

/* ── library emission mode ───────────────────────────────────────────────
 * `scriptc build --lib --profile <file>`: compile the profile's ONE entry module
 * to a linkable static archive (<name>.lib.a) exporting exactly the
 * profile-declared C-ABI symbols — no main, no event loop, no signal
 * handlers, traps to the host's registered sink. The profile pins the
 * emission; there is no fallback concept on this path (an out-of-tier
 * program under emission "llvm" is SC3001, fail-loudly). */

export interface CompileLibraryOptions {
  profilePath: string;
  /** Where the archive and the kept program TU land. */
  outDir: string;
  /** Archive path. Default: <outDir>/<stem>.lib.a. */
  outPath?: string;
  emitIr?: boolean;
  sanitize?: boolean;
}

export type CompileLibraryResult =
  /** `sidecarPath` is present exactly when the profile declares a
   * `sidecar` section: the contract JSON written beside the archive by
   * the same invocation (ask 2). */
  | { ok: true; archivePath: string; cPath: string; backend: "c" | "llvm"; irPath?: string; sidecarPath?: string }
  | { ok: false; diagnostics: ScrDiagnostic[]; sourceTexts: Map<string, string> };

/** The marshalling-class fit over IR types (design §4.2 + the ratified
 * integer plumbing classes): number is every f64-backed class, bool/string
 * map directly, bytes is the u8 element kind. */
function libClassFits(cls: string, t: IrType): boolean {
  switch (cls) {
    case "bool":
      return t.kind === "bool";
    case "string":
      return t.kind === "string";
    case "bytes":
      return t.kind === "bytes" && t.elem === "u8";
    default: // f64 and the u8/u32/i32 plumbing classes
      return t.kind === "f64";
  }
}

/** Resolve the profile's export map against the entry module — SC4002/
 * SC4004/SC4007 from the declaration facts, SC4003 from the lowered IR
 * signatures — and land the library section on the module. */
function resolveLibrarySection(
  profile: LibraryProfile,
  entryInfo: Map<string, EntryExportInfo>,
  mod: IrModule,
  entryPath: string,
): { lib: IrLibSection } | { diagnostics: ScrDiagnostic[] } {
  const diagnostics: ScrDiagnostic[] = [];
  const entryLoc = { file: entryPath, start: 0, end: 0 };
  const fnByName = new Map(mod.functions.map((f) => [f.name, f]));
  const exports: IrLibSection["exports"] = [];
  for (const e of profile.exports) {
    const info = entryInfo.get(e.export);
    if (info === undefined) {
      diagnostics.push(
        libExportUnresolvedDiag(e.export, "the entry module has no exported function declaration by that name", entryLoc),
      );
      continue;
    }
    if (info.generic) {
      diagnostics.push(libGenericExportDiag(e.export, info.loc));
      continue;
    }
    if (info.async || info.generator) {
      diagnostics.push(libAsyncExportDiag(e.export, info.async ? "async" : "generator", info.loc));
      continue;
    }
    const fn = fnByName.get(e.export);
    if (fn === undefined) {
      diagnostics.push(
        libExportUnresolvedDiag(e.export, "the export did not lower to a compiled function", info.loc),
      );
      continue;
    }
    if (fn.params.length !== e.params.length) {
      diagnostics.push(
        libUnmappableSignatureDiag(
          e.export,
          "signature",
          `has ${fn.params.length} parameter(s) but the profile declares ${e.params.length} marshalling class(es)`,
          info.loc,
        ),
      );
      continue;
    }
    let bad = false;
    e.params.forEach((cls, i) => {
      if (!libClassFits(cls, fn.params[i]!.type)) {
        bad = true;
        diagnostics.push(
          libUnmappableSignatureDiag(
            e.export,
            `parameter ${i + 1} ('${fn.params[i]!.name}')`,
            `has IR type '${fn.params[i]!.type.kind}', which does not fit the declared marshalling class '${cls}'`,
            info.loc,
          ),
        );
      }
    });
    if (e.returns === "void" ? fn.returnType.kind !== "void" : !libClassFits(e.returns, fn.returnType)) {
      bad = true;
      diagnostics.push(
        libUnmappableSignatureDiag(
          e.export,
          "the return",
          `has IR type '${fn.returnType.kind}', which does not fit the declared marshalling class '${e.returns}'`,
          info.loc,
        ),
      );
    }
    if (!bad) {
      const resolvedExport: IrLibSection["exports"][number] = {
        symbol: e.symbol,
        fnName: e.export,
        params: e.params,
        returns: e.returns,
      };
      if (e.params.includes("bytes")) {
        // The wrapper's one host-contract trap (an inbound bytes length
        // past the marshalling class's range) is assembled HERE, once, as
        // the structured trap-teaching message: the profile's teaching for
        // SC4012 (or the mode's default text), the code, the trapping
        // export's C symbol exactly as the host linked it, and the
        // profile's remediation when supplied — so both backends emit the
        // same bytes and the sink sees one canonical message.
        resolvedExport.inboundBytesTrap = assembleTrapTeaching(
          profileTeaching(profile, LIB_INBOUND_BYTES_TRAP_CODE) ??
            "scriptc: library inbound bytes length out of range\n",
          LIB_INBOUND_BYTES_TRAP_CODE,
          e.symbol,
          profileRemediation(profile, LIB_INBOUND_BYTES_TRAP_CODE),
        );
      }
      if (e.params.includes("i64") || e.params.includes("u64")) {
        // The sibling host-contract trap for inbound declared-integer
        // parameters (ask 4): a value past ±(2^53−1) cannot ride f64
        // exactly, and silent rounding is a coercion the author never
        // wrote. Same code (SC4012 — one host-contract story), same
        // assembly-once discipline.
        resolvedExport.inboundIntTrap = assembleTrapTeaching(
          profileTeaching(profile, LIB_INBOUND_BYTES_TRAP_CODE) ??
            "scriptc: library inbound integer parameter out of range\n",
          LIB_INBOUND_BYTES_TRAP_CODE,
          e.symbol,
          profileRemediation(profile, LIB_INBOUND_BYTES_TRAP_CODE),
        );
      }
      exports.push(resolvedExport);
    }
  }
  if (diagnostics.length > 0) return { diagnostics };
  // The runtime detected-trap overlay rows: one per family code the profile
  // declares teaching or remediation text for, in the registry family's
  // order. Both backends emit exactly these rows as the program TU's
  // overlay table, so the funnel-assembled sink message is
  // emission-invariant by construction. (SC4012 stays compile-time
  // assembled into the wrapper's message above and never reaches the
  // funnel's assembly path.)
  const trapOverlays: IrLibSection["trapOverlays"] = [];
  for (const code of LIB_RUNTIME_TRAP_CODES) {
    const teaching = profileTeaching(profile, code);
    const remediation = profileRemediation(profile, code);
    if (teaching !== undefined || remediation !== undefined) {
      trapOverlays.push({
        code,
        ...(teaching !== undefined ? { teaching } : {}),
        ...(remediation !== undefined ? { remediation } : {}),
      });
    }
  }
  return {
    lib: {
      profileName: profile.name,
      prefix: profile.prefix,
      initSymbol: profile.initSymbol,
      sinkRegisterSymbol: profile.sinkRegisterSymbol,
      collectSymbol: profile.collectSymbol,
      resultResetSymbol: profile.resultResetSymbol,
      threadInstances: profile.instancePerThread,
      // Host-callback channels: declaration order is the runtime slot
      // assignment, and the unregistered-call trap text is assembled HERE,
      // once, so both backends emit identical constant bytes (a DETECTED
      // trap: the funnel classifies the "scriptc: library callback "
      // prefix as SC4025 and names the entry the host called — the entry
      // is runtime knowledge, so no compile-time SC4012-style assembly
      // can carry it). Both fields stay absent on callback-free profiles
      // (the byte-identity guarantee).
      ...(profile.callbacks.length > 0
        ? {
            callbackRegisterSymbol: profile.callbackRegisterSymbol!,
            callbacks: profile.callbacks.map((cb, i) => ({
              name: cb.name,
              slot: i,
              params: [...cb.params],
              returns: cb.returns,
              unregisteredTrap: `scriptc: library callback '${cb.name}' invoked before registration\n`,
            })),
          }
        : {}),
      exports,
      trapOverlays,
    },
  };
}

/** The export map's integer-slot obligations (ask 4): i64/u64 params and
 * returns become declared boundary slots keyed `exports.<name>.params[i]`
 * / `exports.<name>.return`; the u8/u32/i32 plumbing classes contribute
 * their proven inbound shapes as parameter seeds (the wrapper's coercion
 * contract), tightening the intraprocedural analysis at zero declaration
 * cost. Sidecar-declared slots (record fields, msg arms, helper params
 * and returns) merge into the same config at sidecar build. */
function libraryIntSlotConfig(profile: LibraryProfile): IntSlotConfig {
  const cfg: IntSlotConfig = { fns: new Map(), records: new Map() };
  for (const e of profile.exports) {
    const params = e.params.map((c) => (c === "i64" || c === "u64" ? c : null));
    const ret = e.returns === "i64" || e.returns === "u64" ? e.returns : null;
    const paramSeeds = e.params.map((c) => (c === "u8" || c === "u32" || c === "i32" ? classSeed(c) : null));
    if (params.every((p) => p === null) && ret === null && paramSeeds.every((s) => s === null)) continue;
    const slots: FnIntSlots = {
      fnName: e.export,
      params,
      paramPaths: e.params.map((c, i) => (c === "i64" || c === "u64" ? `exports.${e.export}.params[${i}]` : null)),
      ret,
      retPath: ret !== null ? `exports.${e.export}.return` : null,
      paramSeeds,
    };
    cfg.fns.set(e.export, slots);
  }
  return cfg;
}

/** Match the sidecar syntax's exact structural type projection against the
 * frontend's interned IR registries. The pattern deliberately mirrors
 * ShapeRegistry's identity: every field name and recursively mapped field
 * type participates. Tagged payload records additionally accept omission
 * of their `kind` field because the lowering may carry that discriminant
 * only in the surrounding union tag. */
function sidecarRecordMatcher(
  mod: IrModule,
): (pattern: SidecarIrRecordPattern, shape: IrRecordShape) => boolean {
  const records = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const unions = new Map((mod.unions ?? []).map((union) => [union.id, union]));

  const recordMatches = (
    pattern: SidecarIrRecordPattern,
    shape: IrRecordShape,
  ): boolean => {
    if (shape.tuple === true || shape.indexValue !== undefined) return false;
    const variants = [pattern.fields];
    if (pattern.kindMayBeOmitted === true) {
      variants.push(pattern.fields.filter((field) => field.name !== "kind"));
    }
    return variants.some(
      (fields) =>
        fields.length === shape.fields.length &&
        fields.every((field) => {
          const actual = shape.fields.find((candidate) => candidate.name === field.name);
          return actual !== undefined && typeMatches(field.type, actual.type);
        }),
    );
  };

  const unionMatches = (
    patterns: SidecarIrTypePattern[],
    actual: IrType[],
  ): boolean => {
    if (patterns.length !== actual.length) return false;
    const used = new Set<number>();
    const visit = (index: number): boolean => {
      if (index === patterns.length) return true;
      for (let i = 0; i < actual.length; i++) {
        if (used.has(i) || !typeMatches(patterns[index]!, actual[i]!)) continue;
        used.add(i);
        if (visit(index + 1)) return true;
        used.delete(i);
      }
      return false;
    };
    return visit(0);
  };

  const typeMatches = (
    pattern: SidecarIrTypePattern,
    actual: IrType,
  ): boolean => {
    switch (pattern.kind) {
      case "f64":
      case "string":
      case "bool":
      case "nullT":
      case "undefinedT":
      case "dyn":
        return actual.kind === pattern.kind;
      case "bytes":
        return actual.kind === "bytes" && actual.elem === pattern.elem;
      case "array":
        return actual.kind === "array" && typeMatches(pattern.elem, actual.elem);
      case "record": {
        if (actual.kind !== "record") return false;
        const shape = records.get(actual.shapeId);
        return shape !== undefined && recordMatches(pattern, shape);
      }
      case "union": {
        if (actual.kind !== "union") return false;
        const union = unions.get(actual.unionId);
        return union !== undefined && unionMatches(pattern.arms, union.arms);
      }
    }
  };

  return (pattern, shape) => recordMatches(pattern, shape);
}

/** Merge the sidecar-resolved integer slots (ask 4) into the inference
 * config: helper slots key by function name and IR parameter index (the
 * projection already shifted past the model receiver); record-field
 * slots map onto every interned IR shape whose complete structural field
 * signature matches the projected record's. Shapes intern structurally,
 * so a same-shaped second type shares the obligation. DECLARED paths with
 * the same class coalesce while retaining every source path for verdicts;
 * differing classes refuse because one lowered field cannot seed or check
 * two distinct class contracts without arm provenance. A
 * record fact that matches no shape binds nothing: no compiled code
 * constructs the type (the contract surface — init/update/subscriptions
 * and every helper — is force-lowered whenever integer slots are
 * declared, so this is genuine vacuity, not dead-stripping). */
function mergeSidecarIntSlots(
  cfg: IntSlotConfig,
  facts: SidecarIntegerSlotFacts,
  mod: IrModule,
): { ok: true; config: IntSlotConfig } | { ok: false; diagnostic: ScrDiagnostic } {
  const recordMatches = sidecarRecordMatcher(mod);
  for (const h of facts.helpers) {
    const fn = mod.functions.find((f) => f.name === h.fnName);
    const arity = Math.max(fn?.params.length ?? 0, (h.index ?? 0) + 1);
    let slots = cfg.fns.get(h.fnName);
    if (slots === undefined) {
      slots = {
        fnName: h.fnName,
        params: new Array<null>(arity).fill(null),
        paramPaths: new Array<null>(arity).fill(null),
        ret: null,
        retPath: null,
        paramSeeds: new Array<null>(arity).fill(null),
      };
      cfg.fns.set(h.fnName, slots);
    }
    if (h.kind === "param") {
      const i = h.index!;
      while (slots.params.length <= i) {
        slots.params.push(null);
        slots.paramPaths.push(null);
        slots.paramSeeds.push(null);
      }
      slots.params[i] = h.cls;
      slots.paramPaths[i] = h.path;
    } else {
      slots.ret = h.cls;
      slots.retPath = h.path;
    }
  }
  for (const r of facts.records) {
    for (const shape of mod.records ?? []) {
      if (!recordMatches(r.shape, shape)) continue;
      const target = shape.fields.find((f) => f.name === r.targetField);
      if (target === undefined || numberCarrierKind(target.type, mod) === null) continue;
      let m = cfg.records.get(shape.id);
      if (m === undefined) {
        m = new Map();
        cfg.records.set(shape.id, m);
      }
      const existing = m.get(r.targetField);
      if (existing !== undefined && existing.cls !== r.cls) {
        const paths = [
          ...existing.paths.map((path) => `'${path}' (${existing.cls})`),
          `'${r.path}' (${r.cls})`,
        ];
        return {
          ok: false,
          diagnostic: libSidecarDiag(
            `integer slots ${paths.join(" and ")} collapse to the same lowered record field '${r.targetField}' — their proof obligations cannot be kept distinct`,
            r.loc,
            "kind-tagged union arms and structurally identical records may share one lowered shape — same-class declarations coalesce, but differing classes require distinct structural shapes or at most one classified slot",
          ),
        };
      }
      if (existing === undefined) {
        m.set(r.targetField, { cls: r.cls, paths: [r.path] });
      } else if (!existing.paths.includes(r.path)) {
        existing.paths.push(r.path);
      }
    }
  }
  return { ok: true, config: cfg };
}

function libraryNativeFeatures(
  mod: IrModule,
  backend: "c" | "llvm",
): EarlyLibraryNativeFeatures {
  return {
    backend,
    regex: moduleUsesRegex(mod),
    assert: moduleUsesAssert(mod),
    inspect: moduleUsesInspect(mod),
    symbol: moduleUsesSymbol(mod),
    searchParams: moduleUsesSearchParams(mod),
    emitter: moduleUsesEmitter(mod),
    zlib: moduleUsesZlib(mod),
    copying: moduleUsesCopying(mod),
    textDecoderLegacy: moduleUsesLegacyTextDecoder(mod),
    ...(mod.lib?.identity !== undefined ? { buildId: mod.lib.identity.buildId } : {}),
  };
}

function libraryLocalizeSymbols(profile: LibraryProfile): string[] | undefined {
  return profile.localizeRuntime
    ? [
        profile.initSymbol,
        profile.sinkRegisterSymbol,
        ...(profile.collectSymbol !== null ? [profile.collectSymbol] : []),
        ...(profile.resultResetSymbol !== null ? [profile.resultResetSymbol] : []),
        ...(profile.callbackRegisterSymbol !== null ? [profile.callbackRegisterSymbol] : []),
        ...(profile.sidecar !== null
          ? [profile.sidecar.buildIdSymbol, profile.sidecar.abiVersionSymbol]
          : []),
        ...profile.exports.map((entry) => entry.symbol),
      ]
    : undefined;
}

async function compileLibraryNative(
  profile: LibraryProfile,
  cPath: string,
  archivePath: string,
  sanitize: boolean,
  features: EarlyLibraryNativeFeatures,
): Promise<void> {
  const localizeSymbols = libraryLocalizeSymbols(profile);
  let identityCSource: string | undefined;
  let programSource: string | undefined;
  if (
    profile.sidecar !== null || profile.emission === "c" ||
    (profile.emission === "llvm" && profile.optimization === "dev" && !sanitize)
  ) {
    const publicSource = await readFile(cPath, "utf8");
    programSource = publicSource;
  }
  if (profile.sidecar !== null) {
    if (features.buildId === undefined) throw new Error("library identity TU has no build id");
    const withoutIdentity = stripLibraryIdentity(programSource!, profile.emission);
    if (withoutIdentity === programSource) {
      throw new Error("generated public library TU has no identity region");
    }
    programSource = withoutIdentity;
    identityCSource = [
      "#include <stdint.h>",
      "#include <inttypes.h>",
      `uint64_t ${profile.sidecar.buildIdSymbol}(void) { return UINT64_C(0x${features.buildId}); }`,
      `uint32_t ${profile.sidecar.abiVersionSymbol}(void) { return ${profile.sidecar.abiVersion}u; }`,
      "",
    ].join("\n");
  }
  if (profile.emission === "c") {
    programSource = stripLibrarySourceComments(programSource!, profile.entry);
  }
  const llvmSplit =
    profile.emission === "llvm" && profile.optimization === "dev" && !sanitize && programSource !== undefined
      ? splitLlvmLibraryProgram(programSource)
      : null;
  await compileLibArchive({
    cPath,
    ...(programSource !== undefined ? { programSource } : {}),
    ...(identityCSource !== undefined ? { identityCSource } : {}),
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
    searchParams: features.searchParams,
    emitter: features.emitter,
    zlib: features.zlib,
    copying: features.copying,
    textDecoderLegacy: features.textDecoderLegacy,
  });
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
      throw new Error("semantic library cache lost sidecar identity metadata");
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
  const stem = basename(profile.entry).replace(/\.(ts|js|mjs|cjs)$/, "");
  const cPath = join(opts.outDir, `${stem}.lib.${profile.emission === "llvm" ? "ll" : "c"}`);
  let translationUnit = hit.translationUnit;
  if (profile.sidecar !== null) {
    translationUnit = replaceLibraryIdentity(translationUnit, profile.emission, mod.lib!.identity!);
  }
  if (profile.emission === "llvm") {
    await writeFile(cPath, translationUnit);
  } else {
    const previous = hit.previousSources.get(mod.sourceFile);
    const current = hit.sourceTexts.get(mod.sourceFile);
    if (previous === undefined || current === undefined) {
      throw new Error("semantic library cache lost the entry source text");
    }
    translationUnit = rebaseLibrarySourceComments(
      translationUnit,
      mod.sourceFile,
      createSourceLineRebaser(mod.sourceFile, previous, current),
    );
    await writeFile(cPath, translationUnit);
  }
  timing("semantic-tu-restore", { output_bytes: Buffer.byteLength(translationUnit) });
  await rm(join(opts.outDir, `${stem}.lib.${profile.emission === "llvm" ? "c" : "ll"}`), { force: true });
  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.lib.ir.json`);
    await writeFile(irPath, serializeModule(mod));
  }
  await compileLibraryNative(
    profile,
    cPath,
    archivePath,
    opts.sanitize ?? false,
    hit.native,
  );
  timing("native-archive");
  let sidecarPath: string | undefined;
  if (sidecarJson !== null) {
    sidecarPath = profile.sidecar!.path !== null
      ? resolve(dirname(archivePath), profile.sidecar!.path)
      : `${archivePath}.contract.json`;
    await writeFile(sidecarPath, sidecarJson);
  }
  await publishEarlyLibraryCache(cacheRoot, cacheOptions, {
    cPath,
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
    cPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}

export async function compileLibrary(opts: CompileLibraryOptions): Promise<CompileLibraryResult> {
  const frontendInputs = new FrontendInputTracker();
  return frontendInputs.run(() => compileLibraryTracked(opts, frontendInputs));
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
  const buildPlatform = buildTargetPlatform();
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
  const archivePath = opts.outPath ?? join(
    opts.outDir,
    `${basename(entryPath).replace(/\.(ts|js|mjs|cjs)$/, "")}.lib.a`,
  );

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

  // Multi-instance library mode (abi.localize_runtime) localizes per
  // OBJECT FORMAT: ELF and COFF archives localize from any host (cross
  // ELF merges through the cross driver's own lld; COFF merges and
  // demotes in process — see cc.ts's localizeLibraryObjects), and Mach-O
  // localization runs the macOS host linker, so macos and ios targets
  // admit darwin hosts only (the mobile admission above already refused
  // an ios triple off darwin). Everything else refuses before frontend/
  // backend work, naming the pairing. WASI retains the general
  // library-mode refusal below.
  if (profile.localizeRuntime && buildPlatform !== "wasi") {
    const driver = resolveCc();
    const platform = targetPlatform(driver);
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
        diagnostics: decorateLibraryRefusals([
          targetRefusalDiag(
            driver.target ?? platform,
            subject,
            { file: entryPath, start: 0, end: 0 },
          ),
        ], profile),
        sourceTexts: new Map(),
      };
    }
  }

  const cacheRoot = provenanceSources() === null
    ? await prepareBuildCacheRoot(buildCacheRoot())
    : null;
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
      earlyHit.cPath,
      archivePath,
      opts.sanitize ?? false,
      earlyHit.native,
    );
    timing("native-archive");
    timing("complete");
    return {
      ok: true,
      archivePath,
      cPath: earlyHit.cPath,
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

  // Bare npm specifiers in a library graph take the STATIC-OR-REFUSE
  // posture: "lib" runs the same auto-detection and eligibility bar as
  // the executable lane's --npm-static (own .d.ts, unminified shipped JS,
  // no build-transform markers), automatically — the library path has no
  // island/dynamic tier to offer (SC4006's ground), so eligibility needs
  // no flag and a miss is a refusal, never a fallback.
  const fe = runFrontend(entryPath, "lib");
  timing("frontend-load", {
    entry_bytes: fe.entryText().length,
    source_files: fe.sourceTexts().size,
  });
  let lowered: LowerResult;
  let entryText: string;
  let sourceTexts: Map<string, string>;
  let entryInfo: Map<string, EntryExportInfo>;
  let contractFacts: ContractFacts | null;
  try {
    // Every library refusal leaves through the ask-5 teaching decoration:
    // profile text attaches by code, manifest id, or fence coverage as the
    // attributed note (the SC4004/SC4005 rider generalized).
    const fail = (diagnostics: ScrDiagnostic[]): CompileLibraryResult => ({
      ok: false,
      diagnostics: decorateLibraryRefusals(diagnostics, profile),
      sourceTexts: fe.sourceTexts(),
    });
    // Library mode emits a host-embedded static archive with native trap and
    // C-ABI contracts. wasm32-wasi executable modules are supported, but the
    // archive/reactor contract is not; refuse before emitting a host-width
    // LLVM TU or asking Zig to compile the native library runtime for WASI.
    if (buildPlatform === "wasi") {
      return fail([
        targetRefusalDiag(
          "wasm32-wasi",
          "library-mode archive builds",
          { file: entryPath, start: 0, end: 0 },
        ),
      ]);
    }
    // The npm verdicts FIRST: whatever the shared frontend would have
    // served from the island — an eligibility miss, an untyped install, a
    // preflight offender inside a package's files, a dropped inferred
    // surface — refuses here with the package and the specific bar it
    // missed. Checked before the general preflight, whose diagnostics for
    // these same imports speak executable-lane teachings (SC1010/SC0001 at
    // the unresolvable edge); the library answer is this one.
    const npmRefused = fe.npmStatic.filter((s) => s.status === "fallback");
    if (npmRefused.length > 0) {
      return fail(
        npmRefused.map((s) =>
          libNpmIneligibleDiag(
            s.package,
            // The one shared offender reason that narrates the executable
            // lane's fallback loses that clause here — no island exists on
            // this path to serve anything.
            (s.detail ?? "its static compilation was refused").replace("; the island serves the package", ""),
            fe.npmImportSites.get(s.package) ?? { file: entryPath, start: 0, end: 0 },
          ),
        ),
      );
    }
    if (fe.preflight.length > 0) return fail(fe.preflight);
    contractFacts = profile.sidecar !== null ? fe.entryContract() : null;
    // Ask 4, contract-surface reachability: when the sidecar declares ANY
    // integer slot, the designated init/update/subscriptions exports and
    // every contract helper (model-first exported function) seed lowering
    // too. They are attested surface — a declared record-field or msg-arm
    // class obligates EVERY write those bodies perform, and a declared
    // helper param is checked at their internal call sites — so the
    // attestation must cover COMPILED bodies, never a dead-stripped
    // vacuity (the bug this closes: a model-slot declaration whose only
    // writers were dead-stripped attested without any proof).
    const contractSurfaceRoots: string[] = [];
    if (profile.sidecar !== null && profile.sidecar.integerSlots.length > 0) {
      const sc = profile.sidecar;
      const fnNames = new Set(contractFacts!.functions.filter((f) => !f.generic).map((f) => f.name));
      for (const name of [sc.initExport, sc.updateExport, sc.subscriptionsExport]) {
        if (fnNames.has(name)) contractSurfaceRoots.push(name);
      }
      for (const fn of contractFacts!.functions) {
        if (fn.generic) continue;
        const first = fn.params[0];
        if (first !== undefined && first.shape !== null && first.shape.k === "ref" && first.shape.name === sc.model) {
          contractSurfaceRoots.push(fn.name);
        }
      }
    }
    // The profile's host-callback channels ride the FFI import machinery:
    // each channel is a signature-only ambient binding whose direct calls
    // lower to ffiCall nodes (the classes are a subset of the FFI's), and
    // `libraryCallbacks` flips the recognition to the library flavor —
    // SC4024 diagnostics, unused channels legal, undeclared references
    // refused with the callback teaching. The library lane never loads a
    // native-FFI manifest, so the channel set owns the surface outright.
    const cbImports: IrFfiImport[] = profile.callbacks.map((cb) => ({
      name: cb.name,
      symbol: cb.name,
      params: [...cb.params],
      returns: cb.returns,
    }));
    try {
      lowered = fe.lower({
        dynamic: false,
        targetPlatform: buildPlatform,
        ...(cbImports.length > 0 ? { ffiImports: cbImports, libraryCallbacks: true } : {}),
        // The profile-mapped exports are called from OUTSIDE the graph:
        // they seed reachability beside the entry's top level (an
        // executable build would dead-strip an uncalled export). A helper
        // with a declared integer slot (ask 4) seeds too: its attestation
        // must cover a COMPILED body, never a dead-stripped vacuity — the
        // sidecar advertises the slot's class, so the proof must exist.
        libRoots: [
          ...new Set([
            ...profile.exports.map((e) => e.export),
            ...(profile.sidecar?.integerSlots ?? [])
              .map((s) => /^helpers\.([^.]+)\.(?:params\[\d+\]|return)$/.exec(s.slot)?.[1])
              .filter((n): n is string => n !== undefined),
            ...contractSurfaceRoots,
          ]),
        ],
      });
      timing("lower", {
        lib_roots: profile.exports.length + contractSurfaceRoots.length,
      });
    } catch (e) {
      if (!isCheckerPanic(e)) throw e;
      return fail([checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 })]);
    }
    if (lowered.module === null) return fail(lowered.diagnostics);
    entryInfo = fe.entryExports();
    entryText = fe.entryText();
    sourceTexts = fe.sourceTexts();
  } finally {
    fe.dispose();
  }
  const mod = lowered.module!;
  timing("frontend-dispose");

  const fail = (diagnostics: ScrDiagnostic[]): CompileLibraryResult => ({
    ok: false,
    diagnostics: decorateLibraryRefusals(diagnostics, profile),
    sourceTexts,
  });

  // Export resolution first (SC4002/SC4003/SC4004/SC4007 anchor at the
  // mapped declaration — a mapped async export reports as SC4004, not the
  // graph-wide gate), then the async_free requirement (ratified, SC4005),
  // then the profile's determinism fences (ask 5, SC4008) over the same
  // compiled graph the attestation scan reads: all refused before anything
  // is emitted, so the narrowed library link set below is structural fact.
  const resolved = resolveLibrarySection(profile, entryInfo, mod, entryPath);
  if ("diagnostics" in resolved) return fail(resolved.diagnostics);
  const asyncSurface = moduleLibAsyncSurface(mod);
  if (asyncSurface !== null) {
    return fail([libAsyncSurfaceDiag(asyncSurface.surface, asyncSurface.loc)]);
  }
  const fenced = evaluateLibraryFences(mod, profile);
  if (fenced.length > 0) return fail(fenced);
  mod.lib = resolved.lib;

  // Ask 4's declared integer slots: the export map's i64/u64 classes
  // seed the config here; sidecar-declared slots (record fields, msg
  // arms, helper params/returns) merge in after the projection resolves
  // them below.
  let intCfg = libraryIntSlotConfig(profile);

  // The ask-2 contract sidecar rides the same invocation. Identity first
  // (schema §2's worked build_id definition over compiler version, profile
  // bytes, and the sorted canonical module graph; source_hash per the
  // profile's "module-graph" contract) — the u64 lands on the IR so native
  // archive assembly emits the identity getters from the ONE value the
  // sidecar records (V12's coherence by construction), then the projection into
  // the schema (declaration orders from the AST) and the V1–V14
  // self-check before anything is written.
  let sidecarJson: string | null = null;
  if (profile.sidecar !== null) {
    const rootDir = dirname(resolve(opts.profilePath));
    const modules = canonicalModuleGraph(rootDir, sourceTexts);
    const { buildId, sourceHash } = libraryIdentityHashes(compilerReleaseVersion(), profile.profileBytes, modules);
    mod.lib.identity = {
      buildIdSymbol: profile.sidecar.buildIdSymbol,
      abiVersionSymbol: profile.sidecar.abiVersionSymbol,
      buildId,
      abiVersion: profile.sidecar.abiVersion,
    };
    const built = buildSidecar({
      profile,
      facts: contractFacts!,
      compilerVersion: compilerReleaseVersion(),
      entry: canonicalPath(rootDir, entryPath),
      buildId,
      sourceHash,
      deterministic: moduleLibNondeterministicSurface(mod) === null,
    });
    if (!built.ok) return fail(built.diagnostics);
    const violations = validateSidecar(built.doc);
    if (violations.length > 0) {
      // The projection above refuses every user-caused shape; a rule
      // violation surviving to here is an emitter bug.
      return fail(violations.map((v) => iceDiag(`sidecar self-check failed — ${v}`, { file: entryPath, start: 0, end: 0 })));
    }
    sidecarJson = built.json;
    const merged = mergeSidecarIntSlots(intCfg, built.integerSlotFacts, mod);
    if (!merged.ok) return fail([merged.diagnostic]);
    intCfg = merged.config;
  }
  timing("contract-sidecar", { source_files: sourceTexts.size });

  // Ask 4: the integer-boundary inference — every value that can reach a
  // profile-declared i64/u64 slot must PROVE representability, wholeness,
  // and range, or the build refuses with the failed obligation, the
  // observed evidence, and the author's fix (SC4021/SC4022/SC4023). Runs
  // only when at least one integer slot is declared; the sidecar (already
  // built above, written only on success) may then attest the classes —
  // §5's invariant that an attested integer class means the proof was
  // discharged holds because no artifact leaves this function otherwise.
  if (hasIntSlots(intCfg)) {
    const refusals = checkLibraryIntegerSlots(mod, intCfg).filter((v) => v.outcome === "refuse");
    if (refusals.length > 0) {
      return fail(refusals.map((v) => libIntBoundaryDiag(v.path, v.cls, v.obligation!, v.detail!, v.fix!, v.loc)));
    }
  }
  timing("integer-proof");

  const validation = validateModule(mod);
  if (validation.length > 0) return fail(validation.map((v) => iceDiag(v.message, v.loc)));
  timing("ir-validate");

  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  let cPath: string;
  if (profile.emission === "llvm") {
    try {
      const ll = emitLlvmModule(mod);
      timing("llvm-emit", { output_bytes: Buffer.byteLength(ll) });
      cPath = join(opts.outDir, `${stem}.lib.ll`);
      await writeFile(cPath, ll);
      timing("llvm-write");
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      // The profile PINS the emission — fail-loudly, never a lane change.
      return fail([llvmRefusalDiag(err, entryPath)]);
    }
  } else {
    cPath = join(opts.outDir, `${stem}.lib.c`);
    await writeFile(cPath, emitModule(mod, entryText));
  }
  await rm(join(opts.outDir, `${stem}.lib.${profile.emission === "llvm" ? "c" : "ll"}`), { force: true });

  let irPath: string | undefined;
  if (opts.emitIr) {
    irPath = join(opts.outDir, `${stem}.lib.ir.json`);
    await writeFile(irPath, serializeModule(mod));
  }

  const nativeFeatures = libraryNativeFeatures(mod, profile.emission);
  await compileLibraryNative(
    profile,
    cPath,
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
    cPath,
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
    cPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}
