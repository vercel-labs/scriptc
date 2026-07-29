import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CcCompileError, compileC, compileLibArchive, resolveCc, targetPlatform } from "./backend/cc.js";
import { emitModule } from "./backend/emission/emitter.js";
import { emitLlvmModule, LlvmUnsupportedError } from "./backend/llvm/emitter.js";
import { checkerPanicDiag, ffiNativeBuildDiag, libAsyncExportDiag, libAsyncSurfaceDiag, libExportUnresolvedDiag, libGenericExportDiag, libIntBoundaryDiag, libNpmIneligibleDiag, libUnmappableSignatureDiag, iceDiag, isCheckerPanic, LIB_INBOUND_BYTES_TRAP_CODE, LIB_RUNTIME_TRAP_CODES, type ScrDiagnostic } from "./diagnostics/diagnostic.js";
import { checkLibraryIntegerSlots, classSeed, hasIntSlots, type FnIntSlots, type IntSlotConfig } from "./library/int-infer.js";
import { loadLibraryProfile, profileRemediation, profileTeaching, type LibraryProfile } from "./library/profile.js";
import { decorateLibraryRefusals, evaluateLibraryFences } from "./library/fence-eval.js";
import { assembleTrapTeaching } from "./library/trap-teaching.js";
import {
  buildSidecar,
  canonicalModuleGraph,
  canonicalPath,
  compilerReleaseVersion,
  libraryIdentityHashes,
  type SidecarIntegerSlotFacts,
} from "./library/sidecar.js";
import { validateSidecar } from "./library/sidecar-validate.js";
import { entryFunctionExports, type EntryExportInfo } from "./frontend/lib-exports.js";
import { entryContractFacts, type ContractFacts } from "./frontend/lib-contract.js";
import { moduleLibAsyncSurface, moduleLibNondeterministicSurface, moduleEmbedsBuiltin, moduleEmbedsCompressedNpm, moduleEmbedsTypelessWarning, moduleUsesAssert, moduleUsesDc, moduleUsesDgram, moduleUsesDynAsync, moduleUsesDynInvoke, moduleUsesEmitter, moduleUsesFetch, moduleUsesFsWatch, moduleUsesHttp2, moduleUsesHttpServer, moduleUsesInspect, moduleUsesNet, moduleUsesNodeTest, moduleUsesProcessEvents, moduleUsesQs, moduleUsesRegex, moduleUsesSearchParams, moduleUsesStream, moduleUsesSymbol, moduleUsesTls, moduleUsesTlsCa, moduleUsesZlib, type IrLibSection, type IrModule, type IrType, type SrcLoc } from "./ir/nodes.js";
import { serializeModule } from "./ir/serialize.js";
import { validateModule } from "./ir/validate.js";
import { canonicalBuiltinModule, checkPreflight, isNodeTypesPath, loadProgram, locOf, requiresOf, resolveNpmImport, type LoadResult } from "./frontend/program.js";
import { npmStaticIneligibleReason, npmStaticOffenders, npmStaticPackageOfPath } from "./frontend/npm-static.js";
import { provenanceSources } from "./frontend/provenance-registry.js";
import { resolveBareModule } from "./frontend/resolve.js";
import { isJsSourceFileName, isRelativeSpecifier } from "./frontend/shared.js";
import { lowerToIr, type LowerOptions, type LowerResult } from "./frontend/lowering/lowerer.js";
import type { CoverageInput, NpmStaticStatus } from "./coverage/report.js";
import { loadFfiProfile, type FfiProfile } from "./ffi/profile.js";

export const VERSION = "0.0.1";

export { compileC, runtimeSrcDir, type CcOptions } from "./backend/cc.js";
export { emitModule } from "./backend/emission/emitter.js";
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
  FFI_PARAM_CLASSES,
  FFI_RETURN_CLASSES,
  type FfiFunction,
  type FfiParamClass,
  type FfiProfile,
  type FfiReturnClass,
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
export { ambientDtsPath, overridesDtsPath } from "./frontend/program.js";
export { resolveProvenanceSources } from "./frontend/provenance.js";
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
   * tier falls back to the reference C backend transparently — the IR is
   * backend-agnostic, so only the emit retries; CompileResult records the
   * lane (`backend`, plus `llvmRefusal` when the fallback engaged). ONLY a
   * tier refusal (LlvmUnsupportedError) falls back — every real diagnostic
   * and every ICE fails the build on either lane. Explicit `llvm` is the
   * debugging/CI pin and keeps the fail-loudly contract: an out-of-tier
   * program is diagnostic SC3001 naming the first unsupported construct,
   * never a silent lane change. Explicit `c` pins the C backend. */
  backend?: "c" | "llvm";
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
   * refusal's machine-readable kind tag ("npmEmbedding", "stmt:...", ...). */
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

/** The one frontend, three npm postures: `undefined`/explicit package
 * lists and `"auto"` are the executable lane's (--npm-static; fallback =
 * island). `"lib"` is library mode's mandatory auto twin — the same
 * eligibility bar and the same opt-in machinery, but every fallback
 * status the shared loops record becomes compileLibrary's SC4020
 * static-or-refuse teaching, and the detection closes over the opted-in
 * packages' own bare edges (no island exists to serve a dep from). */
function runFrontend(entryPath: string, npmStatic?: readonly string[] | "auto" | "lib"): Frontend {
  const statuses: NpmStaticStatus[] = [];
  const npmSites = new Map<string, SrcLoc>();
  const judged = new Set<string>();
  let requested: string[] = [];
  if (npmStatic === "auto" || npmStatic === "lib") {
    const scout = loadProgram(entryPath);
    try {
      checkPreflight(scout);
      requested =
        npmStatic === "lib"
          ? detectAutoPackages(scout, statuses, "lib", judged, npmSites)
          : detectAutoPackages(scout, statuses);
    } finally {
      scout.dispose();
    }
  } else if (npmStatic !== undefined) {
    requested = [...new Set(npmStatic)];
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
  let load = loadProgram(entryPath, { npmStatic: requested });
  let preflight = checkPreflight(load);
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
      load = loadProgram(entryPath, { npmStatic: requested });
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
    load = loadProgram(entryPath, { npmStatic: effective });
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
      const probe = loadProgram(entryPath, { npmStatic: [p] });
      const probeDiags = checkPreflight(probe);
      probe.dispose();
      if (probeDiags.some((d) => d.code === "SC0001")) dropWithNote(p);
    }
    load.dispose();
    load = loadProgram(entryPath, { npmStatic: effective });
    preflight = checkPreflight(load);
    if (preflight.some((d) => d.code === "SC0001") && effective.size > 0) {
      for (const p of [...effective]) dropWithNote(p);
      load.dispose();
      load = loadProgram(entryPath, { npmStatic: effective });
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
    lower: (opts) => lowerToIr(finalLoad.program, finalLoad.entry, finalLoad.moduleOrder, { ...opts, startupCrash: finalLoad.startupCrash ?? null }),
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
  const fe = runFrontend(entryPath, opts.npmStatic);
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
  let ffi: FfiProfile | null = null;
  if (opts.ffiProfilePath !== undefined) {
    const loaded = loadFfiProfile(opts.ffiProfilePath);
    if (!loaded.ok) {
      return { ok: false, diagnostics: loaded.diagnostics, sourceTexts: new Map() };
    }
    ffi = loaded.profile;
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
        targetPlatform: buildTargetPlatform(),
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
  let llvmRefusal: string | undefined;
  if (opts.backend !== "c") {
    try {
      const ll = emitLlvmModule(lowered.module!);
      cPath = join(opts.outDir, `${stem}.ll`);
      await writeFile(cPath, ll);
      backend = "llvm";
    } catch (err) {
      if (!(err instanceof LlvmUnsupportedError)) throw err;
      // Explicit backend "llvm" keeps the fail-loudly contract (the
      // debugging/CI pin): SC3001, never a silent lane change.
      if (opts.backend === "llvm") {
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

  await mkdir(dirname(opts.outPath), { recursive: true });
  try {
    await compileC({
      cPath,
      outPath: opts.outPath,
      sanitize: opts.sanitize ?? false,
      dynamic: opts.dynamic ?? false,
      // The link switch for scr_regex.c + libregexp: detected on the IR, so
      // regex-free programs keep the historical (pinned) command line.
      regex: moduleUsesRegex(lowered.module),
      // The link switch for scr_fetch.c (the native bridge over scr_net +
      // scr_tls + scr_http's client parser + zlib — cc.ts implies those
      // units into the link): embedded npm code that references fetch gets
      // the bridge; everything else keeps its exact link line.
      fetch: moduleUsesFetch(lowered.module),
      // The island's node:http/https client bridge: embedded graphs that
      // import those builtins pull scr_net_island.c + the socket units.
      netIsland:
        moduleEmbedsBuiltin(lowered.module, "node:http") ||
        moduleEmbedsBuiltin(lowered.module, "node:https") ||
        moduleEmbedsBuiltin(lowered.module, "node:net") ||
        moduleEmbedsBuiltin(lowered.module, "node:tls"),
      // The link switch for scr_zlib.c + libz: zlib.* libCalls on the IR,
      // node:zlib in the embedded graph, or COMPRESSED embedded module text
      // (emit-island.ts stores big npm sources as raw DEFLATE; the emitted
      // main installs scr_zlib_inflate_exact on the same predicate).
      zlib: moduleUsesZlib(lowered.module) || moduleEmbedsCompressedNpm(lowered.module),
      // The link switch for scr_assert.c: assert.* libCalls on the IR (the
      // regex switch also pulls it — scr_regex.c calls the assert helpers).
      assert: moduleUsesAssert(lowered.module),
      // The link switch for scr_inspect.c: insp.* libCalls on the IR.
      inspect: moduleUsesInspect(lowered.module),
      // The link switch for scr_dyn_invoke.c: dynInvoke nodes or
      // dyn.defineProps libCalls on the IR.
      dynInvoke: moduleUsesDynInvoke(lowered.module),
      // The link switch for scr_dc.c: dc.* libCalls on the IR (the
      // diagnostics_channel registry and pub/sub).
      dc: moduleUsesDc(lowered.module),
      // The link switch for scr_async_dyn.c: the checked-dynamic async
      // surfaces and embedded typeless-package warnings, whose dispatcher
      // carries process listeners and the once-per-process trace hint
      // (cc.ts also pulls it under the dynInvoke/dc gates).
      dynAsync:
        moduleUsesDynAsync(lowered.module) ||
        moduleEmbedsTypelessWarning(lowered.module),
      // The link switch for scr_events.c: process signal/exit listeners and
      // the stdin event surface on the IR.
      events: moduleUsesProcessEvents(lowered.module),
      // The link switch for scr_events_emitter.c: the node:events
      // EventEmitter surface on the IR (emitter.* libCalls or the
      // %EventEmitter class def).
      emitter: moduleUsesEmitter(lowered.module),
      // The link switch for scr_symbol.c: sym.* libCalls or a symbol-kind
      // type anywhere on the IR.
      symbol: moduleUsesSymbol(lowered.module),
      // The link switch for scr_url_params.c: sp.* libCalls, the
      // url.searchParams getter, or a searchParams-kind type on the IR.
      searchParams: moduleUsesSearchParams(lowered.module),
      // The link switch for scr_qs.c: the qs.* libCalls that live there
      // (parse/stringify/unescape; escape rides the always-linked encoder).
      qs: moduleUsesQs(lowered.module),
      // The link switch for scr_stream.c: the node:stream class surface on
      // the IR (stream libCalls or the %Readable-family class defs).
      stream: moduleUsesStream(lowered.module),
      // The link switch for scr_net.c: net.* (or http.* — http rides on
      // net) libCalls on the IR.
      net: moduleUsesNet(lowered.module),
      // The link switch for scr_http.c: http.* libCalls on the IR.
      http: moduleUsesHttpServer(lowered.module),
      http2: moduleUsesHttp2(lowered.module),
      // The link switch for scr_dgram.c: dgram.* or dns.* libCalls on the IR.
      dgram: moduleUsesDgram(lowered.module),
      // The link switch for scr_watch.c: fs.watch/watcher.* libCalls on the IR.
      watch: moduleUsesFsWatch(lowered.module),
      // The link switch for scr_test.c: test.* libCalls on the IR.
      nodeTest: moduleUsesNodeTest(lowered.module),
      // The link switch for scr_tls.c + the vendored mbedTLS archive:
      // tls.* or https.* libCalls on the IR.
      tls: moduleUsesTls(lowered.module),
      // The link switch for scr_tls_ca.c (the CA-store introspection unit
      // — plain PEM bookkeeping, no mbedTLS): tlsca.* libCalls on the IR.
      // cc.ts also compiles it under the tls gate (scr_tls.c consults the
      // unit's default-set override for its trust anchors).
      tlsCa: moduleUsesTlsCa(lowered.module),
      ...(ffi !== null
        ? {
            linkInputs: ffi.libraries,
            systemLibraries: ffi.systemLibraries,
          }
        : {}),
    });
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

/** Merge the sidecar-resolved integer slots (ask 4) into the inference
 * config: helper slots key by function name and IR parameter index (the
 * projection already shifted past the model receiver); record-field
 * slots map onto every interned IR shape whose field-name set matches
 * the projected record's — shapes intern structurally, so a same-shaped
 * second type shares the obligation (a sound over-approximation). A
 * record fact that matches no shape binds nothing: no compiled code
 * constructs the type (the contract surface — init/update/subscriptions
 * and every helper — is force-lowered whenever integer slots are
 * declared, so this is genuine vacuity, not dead-stripping). */
function mergeSidecarIntSlots(cfg: IntSlotConfig, facts: SidecarIntegerSlotFacts, mod: IrModule): IntSlotConfig {
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
    const wanted = new Set(r.fieldNames);
    const wantedSansKind = new Set(r.fieldNames.filter((n) => n !== "kind"));
    for (const shape of mod.records ?? []) {
      if (shape.tuple === true || shape.indexValue !== undefined) continue;
      const names = shape.fields.map((f) => f.name);
      if (names.some((n) => n.startsWith("%"))) continue;
      // The union discriminant may or may not materialize as a shape
      // field depending on the arm's lowering; match either spelling.
      const matches =
        (names.length === wanted.size && names.every((n) => wanted.has(n))) ||
        (names.length === wantedSansKind.size && names.every((n: string) => wantedSansKind.has(n)));
      if (!matches) continue;
      const target = shape.fields.find((f) => f.name === r.targetField);
      if (target === undefined || target.type.kind !== "f64") continue;
      let m = cfg.records.get(shape.id);
      if (m === undefined) {
        m = new Map();
        cfg.records.set(shape.id, m);
      }
      m.set(r.targetField, { cls: r.cls, path: r.path });
    }
  }
  return cfg;
}

export async function compileLibrary(opts: CompileLibraryOptions): Promise<CompileLibraryResult> {
  const loadedProfile = loadLibraryProfile(resolve(opts.profilePath));
  if (!loadedProfile.ok) {
    return { ok: false, diagnostics: loadedProfile.diagnostics, sourceTexts: new Map() };
  }
  const profile = loadedProfile.profile;
  const entryPath = profile.entry;

  // Bare npm specifiers in a library graph take the STATIC-OR-REFUSE
  // posture: "lib" runs the same auto-detection and eligibility bar as
  // the executable lane's --npm-static (own .d.ts, unminified shipped JS,
  // no build-transform markers), automatically — the library path has no
  // island/dynamic tier to offer (SC4006's ground), so eligibility needs
  // no flag and a miss is a refusal, never a fallback.
  const fe = runFrontend(entryPath, "lib");
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
    try {
      lowered = fe.lower({
        dynamic: false,
        targetPlatform: buildTargetPlatform(),
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
  // profile's "module-graph" contract) — the u64 lands on the IR so both
  // backends emit the identity getters from the ONE value the sidecar
  // records (V12's coherence by construction), then the projection into
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
    intCfg = mergeSidecarIntSlots(intCfg, built.integerSlotFacts, mod);
  }

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

  const validation = validateModule(mod);
  if (validation.length > 0) return fail(validation.map((v) => iceDiag(v.message, v.loc)));

  await mkdir(opts.outDir, { recursive: true });
  const stem = basename(entryPath).replace(/\.(ts|js|mjs|cjs)$/, "");
  let cPath: string;
  if (profile.emission === "llvm") {
    try {
      const ll = emitLlvmModule(mod);
      cPath = join(opts.outDir, `${stem}.lib.ll`);
      await writeFile(cPath, ll);
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

  const archivePath = opts.outPath ?? join(opts.outDir, `${stem}.lib.a`);
  await compileLibArchive({
    cPath,
    outPath: archivePath,
    sanitize: opts.sanitize ?? false,
    regex: moduleUsesRegex(mod),
    assert: moduleUsesAssert(mod),
    inspect: moduleUsesInspect(mod),
    symbol: moduleUsesSymbol(mod),
    searchParams: moduleUsesSearchParams(mod),
    emitter: moduleUsesEmitter(mod),
    zlib: moduleUsesZlib(mod),
  });

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
  return {
    ok: true,
    archivePath,
    cPath,
    backend: profile.emission,
    ...(irPath !== undefined ? { irPath } : {}),
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
  };
}
