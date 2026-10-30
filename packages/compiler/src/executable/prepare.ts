import type { CompileFailure, CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { frontendDisposed } from "../frontend/dispose-hook.js";
import {
  checkerPanicDiag,
  nodeIslandNoteDiag,
  nodeIslandRetryFailedDiag,
  npmStaticRefusalDiag,
  iceDiag,
  isCheckerPanic,
  stdioPatchAcrossIslandsDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { IrModule, SrcLoc } from "../ir/ir.js";
import { validateModule } from "../ir/validate.js";
import { checkContracts } from "../contracts/check.js";
import {
  fenceSpeculativeWasiFunctions,
  moduleWasiUnavailableSurface,
  targetRefusalDiag,
} from "../backend/target-diagnostics.js";
import type { LowerResult, LowerStats } from "../frontend/lowering/lowerer.js";
import type { FrontendFactory } from "../frontend/pipeline.js";
import type { UnitStore } from "../frontend/lowering/unit-reuse.js";
import type { CompilationTiming } from "../timing.js";
import { readProjectConfig } from "../project-config.js";
import { nodeIslandPolicy } from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import type { IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import { classifyDiagnostic, isIslandReasonCode } from "../node-islands/classify.js";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import { describe } from "../node-islands/summary.js";
import { resolveBareModule } from "../frontend/resolve.js";
import { trackedReadFile } from "../frontend/input-tracker.js";
import { isEsmFile } from "../frontend/lowering/lower-node-island.js";
import type { PackageEdge } from "../node-islands/scan.js";

export interface PreparedExecutableModule {
  ok: true;
  mod: IrModule;
  sourceTexts: Map<string, string>;
  stats: LowerStats;
  /** Divergence warnings (SC6xxx): the build succeeds; these sites can
   * behave differently from Node. */
  warnings: ScrDiagnostic[];
}

/** Release the parser/checker before native object generation begins.
 * `unitStore` keeps the lowered units of this build for the next one
 * (unit-reuse.ts). */
export function prepareExecutableModule(
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: CompilationTiming = () => {},
  lowerIslands: ReadonlyMap<string, IslandPackage> = new Map(),
  retryFences = true,
  unitStore: UnitStore | null = null,
): PreparedExecutableModule | CompileFailure {
  // The island decision reads the detector's scan unless islands are off.
  const islandMode = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands).mode;
  const islandScan = islandMode !== "off";
  let fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, { islandScan });
  timing("frontend-load");
  // Node islands (scope-B NI-4): packages refused natively run in Node,
  // unless the policy says otherwise. The frontend reloads without them,
  // so their declarations type the program.
  const islandDecision = decideNodeIslands(entryPath, opts, fe, lowerIslands);
  if (islandDecision !== null) {
    fe.dispose();
    fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, {
      islandPackages: new Set(islandDecision.packages.keys()),
      islandScan,
      islandTypeRoots: islandTypeRootsOf(entryPath, islandDecision.packages),
    });
    timing("frontend-island-reload");
  }
  let lowered: LowerResult;
  let sourceTexts: Map<string, string>;
  let disposed = false;
  let fenceGrown: Map<string, IslandPackage> | null = null;
  const fenceSure = new Set<string>();
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    const fail = (diagnostics: ScrDiagnostic[]): CompileFailure => ({
      ok: false,
      diagnostics,
      sourceTexts: fe.sourceTexts(),
    });

    const refused = fe.npmStatic.filter((entry) => entry.status === "refused");
    if (refused.length > 0) {
      return fail(
        refused.map((entry) =>
          npmStaticRefusalDiag(
            entry.package,
            entry.detail ?? "its static compilation was refused",
            fe.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 },
            entry.hint,
          ),
        ),
      );
    }
    if (fe.preflight.length > 0) {
      // An import of a natively compiled package that preflight refuses
      // in the importer (a CommonJS namespace import) is that package's
      // refusal: it runs in a Node island instead.
      const grown = preflightIslands(entryPath, opts, fe, lowerIslands);
      if (grown !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          grown,
          retryFences,
          unitStore,
        );
      }
      return fail(fe.preflight);
    }

    try {
      lowered = fe.lower(
        {
          ...(islandDecision !== null ? { nodeIslands: islandDecision } : {}),
          nodeIslandMode: islandMode,
          targetPlatform: buildPlatform,
          ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
          ...(opts.tier !== undefined ? { tierMode: opts.tier } : {}),
          ...(unitStore !== null ? { unitStore } : {}),
        },
        (module) => validateModule(module).length === 0,
      );
      timing("lower");
    } catch (e) {
      // The last-resort panic fence: an upstream tsgo panic that crossed a
      // checker call no statement/collection fence wrapped still becomes a
      // clean failed compile (anchored at the entry), never a crashed CLI.
      if (!isCheckerPanic(e)) throw e;
      return fail([
        checkerPanicDiag(e.message.split("\n", 1)[0]!, { file: entryPath, start: 0, end: 0 }),
      ]);
    }
    if (lowered.module === null) {
      // Packages whose own modules refused to lower run in Node islands
      // too (the authoritative lowering, DESIGN.md §1.4): build again with
      // them as islands.
      // A computed import() of the program's own CommonJS module names a
      // package that runs in an island whole (SPEC §5.6).
      const grown =
        cjsNamespaceIslands(entryPath, opts, fe, lowered.diagnostics, lowerIslands) ??
        loweringIslands(
          entryPath,
          opts,
          fe,
          lowered.diagnostics,
          lowerIslands,
          fe.nodeIslandScan?.({ userJs: false }).edges,
        );
      if (grown !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          grown,
          retryFences,
          unitStore,
        );
      }
      // A failed program whose compiled packages need the runtime or a
      // mutable object model (NI-2's report): try them as islands. If that
      // build fails too, its failure is the one reported. This build typed
      // those packages from their JavaScript, where the types they only
      // declare (interfaces, aliases such as `Static<T>`) are `any`, so its
      // diagnostics describe a program the island build does not compile:
      // there the packages' declarations type the user code.
      const marked = retryFences
        ? fenceIslands(entryPath, opts, fe, lowered, lowerIslands, false)
        : null;
      if (marked !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          marked,
          false,
        );
      }
      return fail(lowered.diagnostics);
    }

    // A program that replaces a process output stream's write method has
    // nowhere to route an island's writes: the island's process.stdout is
    // its own object. Until islands share the native stream object (H2),
    // refuse the combination instead of silently missing the patch.
    if (islandDecision !== null && lowered.stdioPatches !== undefined) {
      return fail(lowered.stdioPatches.map((p) => stdioPatchAcrossIslandsDiag(p.stream, p.loc)));
    }

    const validation = validateModule(lowered.module);
    timing("ir-validate");
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
      fenceSpeculativeWasiFunctions(lowered.module);
      const unavailable = moduleWasiUnavailableSurface(lowered.module);
      if (unavailable !== null) {
        return fail([targetRefusalDiag("wasm32-wasi", unavailable.surface, unavailable.loc)]);
      }
    }
    sourceTexts = fe.sourceTexts();
    if (lowered.contracts) {
      const checked = checkContracts(lowered.module, lowered.contracts, sourceTexts);
      timing("contracts");
      if (checked.diagnostics.length > 0) return fail(checked.diagnostics);
      if (checked.contracts) lowered.module.contracts = checked.contracts;
    }
    if (retryFences)
      fenceGrown = fenceIslands(entryPath, opts, fe, lowered, lowerIslands, true, fenceSure);
  } finally {
    if (!disposed) {
      fe.dispose();
      frontendDisposed();
      timing("frontend-dispose");
    }
  }

  const prepared: PreparedExecutableModule = {
    ok: true,
    mod: lowered.module!,
    sourceTexts,
    stats: lowered.stats,
    warnings: [
      ...(islandDecision?.notes ?? []),
      ...(fe.warnings ?? []),
      ...(lowered.divergences ?? []),
      ...(lowered.performance ?? []),
    ],
  };
  // Packages compiled with runtime fences that need the JavaScript
  // runtime or a mutable object model (fenceIslands): build again with
  // them as islands, and keep this build when that one cannot compile.
  // If that build fails, retry with only the packages whose fences fire
  // for sure (module-init or runtime fences); if that fails too, the native
  // build carries an SC8023 warning with the island build's first error,
  // never a silent fallback.
  if (fenceGrown !== null) {
    const attempts = [fenceGrown];
    const sure = new Map(
      [...fenceGrown].filter(([name]) => lowerIslands.has(name) || fenceSure.has(name)),
    );
    if (sure.size > lowerIslands.size && sure.size < fenceGrown.size) attempts.push(sure);
    let firstError: ScrDiagnostic | null = null;
    for (const islands of attempts) {
      const islanded = prepareExecutableModule(
        entryPath,
        opts,
        ffi,
        buildPlatform,
        createFrontend,
        timing,
        islands,
        false,
        unitStore,
      );
      if (islanded.ok) return islanded;
      firstError ??= islanded.diagnostics[0] ?? null;
    }
    if (firstError !== null) {
      const added = [...fenceGrown.keys()].filter((name) => !lowerIslands.has(name));
      prepared.warnings.push(
        nodeIslandRetryFailedDiag(added, firstError, { file: entryPath, start: 0, end: 0 }),
      );
    }
  }
  return prepared;
}

/** The packages a build runs in Node islands, or null for none: under
 * `--node-islands=auto` (the default) every npm package the native
 * pipeline refused, plus packages marked `node`; under `explicit` only the
 * marked ones; under `off`, none (refusals stay SC2013). Each island is
 * reported once as an SC8001 note. */
function decideNodeIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  lowerIslands: ReadonlyMap<string, IslandPackage>,
): (NodeIslandSet & { notes: ScrDiagnostic[] }) | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode === "off" || fe.nodeIslandScan === undefined) return null;
  // A package marked native stays refused: the build reports it rather
  // than running it in Node.
  const refused = new Set(
    policy.mode === "auto"
      ? fe.npmStatic
          .filter((e) => e.status === "refused" && !policy.forcedNative.has(e.package))
          .map((e) => e.package)
      : [],
  );
  for (const name of lowerIslands.keys()) refused.add(name);
  if (refused.size === 0 && policy.forcedNode.size === 0) return null;
  const report = buildNodeIslandReport({
    entry: entryPath,
    scan: fe.nodeIslandScan({ userJs: false }),
    npm: fe.npmStatic,
    diagnostics: [],
    fences: [],
    policy,
  });
  const packages = new Map<string, IslandPackage>();
  const notes: ScrDiagnostic[] = [];
  const seen = new Set<string>();
  for (const island of report.islands) {
    if (island.path === null) continue;
    seen.add(island.package);
    if (!refused.has(island.package) && !policy.forcedNode.has(island.package)) continue;
    packages.set(island.package, {
      name: island.package,
      version: island.version,
      dir: island.path,
      class: island.class,
      reason: island.reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        island.package,
        island.version,
        island.class,
        island.reason,
        island.importedFrom[0] ??
          fe.npmImportSites.get(island.package) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // Refused packages the report has no installed directory for (refused
  // before they joined the program): their directory from the runtime
  // entry Node resolves.
  for (const name of refused) {
    if (packages.has(name) || lowerIslands.has(name)) continue;
    const site = fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 };
    const js =
      resolveBareModule(site.file, name, "js-only") ??
      resolveBareModule(site.file, name, "js-only", "require");
    const at = js === null ? null : packageDirOf(js.typesFile);
    if (at === null) continue;
    const status = fe.npmStatic.find((e) => e.package === name);
    packages.set(name, {
      name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: "packaging",
      reason: status?.detail ?? "its static compilation was refused",
    });
    notes.push(
      nodeIslandNoteDiag(name, packageVersionOf(at.dir), "packaging", status?.detail ?? "", site),
    );
  }
  // Packages islanded by their lowering refusals keep their first reason
  // (the reload no longer compiles them, so the scan has no reason).
  for (const [name, island] of lowerIslands) {
    if (seen.has(name) && packages.has(name)) {
      const kept = packages.get(name)!;
      if (kept.reason === "" || kept.class === "") packages.set(name, island);
      continue;
    }
    packages.set(name, island);
    notes.push(
      nodeIslandNoteDiag(
        island.name,
        island.version,
        island.class,
        island.reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  return packages.size === 0 ? null : { packages, notes };
}

/** The island set grown by the npm packages whose own modules refused to
 * lower (`--node-islands=auto` only), or null when there are none. */
function loweringIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  diagnostics: readonly ScrDiagnostic[],
  known: ReadonlyMap<string, IslandPackage>,
  edges: readonly PackageEdge[] | undefined,
): Map<string, IslandPackage> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 16) return null;
  const compiled = new Set(fe.npmStatic.filter((e) => e.status === "static").map((e) => e.package));
  const grown = new Map(known);
  for (const d of diagnostics) {
    // A use of a package outside the compiled module graph (an import()
    // the frontend did not compile): that package runs in an island.
    const named = d.code === "SC2013" ? /npm package '([^']+)'/.exec(d.message) : null;
    if (named !== null) {
      const name = named[1]!;
      if (grown.has(name) || policy.forcedNative.has(name) || policy.unloaded.has(name)) continue;
      const js =
        resolveBareModule(d.loc.file, name, "js-only") ??
        resolveBareModule(d.loc.file, name, "js-only", "require");
      const at = js === null ? null : packageDirOf(js.typesFile);
      if (at === null || at.name !== name) continue;
      grown.set(name, {
        name,
        version: packageVersionOf(at.dir),
        dir: at.dir,
        class: "packaging",
        reason: `${d.code}: ${d.message}`,
      });
      continue;
    }
    if (!isIslandReasonCode(d.code)) continue;
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || grown.has(at.name)) continue;
    if (policy.forcedNative.has(at.name) || policy.unloaded.has(at.name)) continue;
    const reason = classifyDiagnostic(d, "refusal");
    grown.set(at.name, {
      name: at.name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: reason.class,
      reason: describe(reason),
    });
  }
  // A native ES module that imports an island CommonJS module would read
  // its bindings from the module's exports object, where Node gives it the
  // namespace its CommonJS facade builds (the lexed names, module.exports
  // as the default): the importing package runs in the island too.
  for (let added = edges !== undefined; added;) {
    added = false;
    for (const edge of edges!) {
      const name = edge.to;
      if (!grown.has(name) || edge.fromDir === null || edge.shim) continue;
      const at = packageDirOf(edge.fromFile);
      if (at === null || grown.has(at.name) || !compiled.has(at.name)) continue;
      if (policy.forcedNative.has(at.name) || policy.unloaded.has(at.name)) continue;
      if (!isEsmFile(edge.fromFile)) continue;
      const target =
        resolveBareModule(edge.fromFile, name, "js-only") ??
        resolveBareModule(edge.fromFile, name, "js-only", "require");
      if (target === null || isEsmFile(target.typesFile)) continue;
      grown.set(at.name, {
        name: at.name,
        version: packageVersionOf(at.dir),
        dir: at.dir,
        class: "packaging",
        reason: `an ES module of the package imports the CommonJS island package '${name}'`,
      });
      added = true;
    }
  }
  return grown.size === known.size ? null : grown;
}

/** The declaration entries the island packages need rooted: a package whose
 * declarations are ambient `declare module "<pkg>/..."` blocks in one file
 * (highlight.js 10.7.3 ships only types/index.d.ts, naming its subpaths)
 * types its subpath imports only when that file is part of the program. A
 * root of that shape adds declarations of the islanded package alone,
 * never a runtime module and never another package's surface. */
function islandTypeRootsOf(
  entryPath: string,
  packages: ReadonlyMap<string, IslandPackage>,
): string[] {
  const roots: string[] = [];
  for (const name of packages.keys()) {
    const resolved = resolveBareModule(entryPath, name, "types-only");
    if (resolved === null || resolved.packageName !== name) continue;
    if (!/\.d\.(?:ts|mts|cts)$/.test(resolved.typesFile)) continue;
    const text = trackedReadFile(resolved.typesFile);
    if (text === null) continue;
    const ambient = new RegExp(
      `declare module\\s+["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    );
    if (ambient.test(text)) roots.push(resolved.typesFile);
  }
  return roots.sort();
}

/** The packages whose CommonJS modules a computed `import()` of the
 * program's own graph names (`--node-islands=auto` only, SPEC §5.6): the
 * module's namespace comes from module.exports through Node's CJS lexer, so
 * the package that owns it runs in an island whole, and the import() becomes
 * a namespace import of an island package. Null when there are none. */
function cjsNamespaceIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  diagnostics: readonly ScrDiagnostic[],
  known: ReadonlyMap<string, IslandPackage>,
): Map<string, IslandPackage> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 16) return null;
  const compiled = new Set(fe.npmStatic.filter((e) => e.status === "static").map((e) => e.package));
  if (compiled.size === 0) return null;
  const grown = new Map(known);
  for (const d of diagnostics) {
    if (d.code !== "SC1090") continue;
    const named = /^dynamic import of the program's own CommonJS module '([^']+)'/.exec(d.message);
    if (named === null) continue;
    const spec = named[1]!;
    const js =
      resolveBareModule(d.loc.file, spec, "js-only") ??
      resolveBareModule(d.loc.file, spec, "js-only", "require");
    const at = js === null ? null : packageDirOf(js.typesFile);
    if (at === null || !compiled.has(at.name) || grown.has(at.name)) continue;
    if (policy.forcedNative.has(at.name) || policy.unloaded.has(at.name)) continue;
    const reason = classifyDiagnostic(d, "refusal");
    grown.set(at.name, {
      name: at.name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: reason.class,
      reason: describe(reason),
    });
  }
  return grown.size === known.size ? null : grown;
}

/** Preflight refusals at import statements of natively compiled npm
 * packages (`--node-islands=auto` only): those packages become islands. */
function preflightIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  known: ReadonlyMap<string, IslandPackage>,
): Map<string, IslandPackage> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 16) return null;
  const compiled = new Set(fe.npmStatic.filter((e) => e.status === "static").map((e) => e.package));
  if (compiled.size === 0) return null;
  const texts = fe.sourceTexts();
  const grown = new Map(known);
  for (const d of fe.preflight) {
    if (d.code !== "SC1013") continue;
    const text = texts.get(d.loc.file);
    if (text === undefined) continue;
    // The import statement around the diagnostic: its module specifier.
    const start = text.lastIndexOf("import", d.loc.start);
    const end = text.indexOf(";", d.loc.end);
    const stmt = text.slice(start < 0 ? d.loc.start : start, end < 0 ? text.length : end);
    const m = /\bfrom\s*["']([^"']+)["']/.exec(stmt);
    if (m === null) continue;
    const spec = m[1]!;
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    if (!compiled.has(name) || grown.has(name)) continue;
    if (policy.forcedNative.has(name) || policy.unloaded.has(name)) continue;
    const site = fe.npmImportSites.get(name);
    const jsEntry = site === undefined ? null : resolveBareModule(site.file, spec, "js-only");
    const at = jsEntry === null ? null : packageDirOf(jsEntry.typesFile);
    if (at === null) continue;
    grown.set(name, {
      name,
      version: packageVersionOf(at.dir),
      dir: at.dir,
      class: "gap",
      reason: `${d.code}: ${d.message}`,
    });
  }
  return grown.size === known.size ? null : grown;
}

/** Packages compiled natively with runtime fences (refusals deferred to the
 * operation that reaches them) that should run in islands instead: those
 * with a fence that surely fires (one in top-level module code, which runs
 * when the module evaluates) or that itself needs the runtime (R1). Other
 * fences stay deferred refusals until decision 8 (D6) retires them, so
 * typed packages like jose stay native. With `requireFence` false (after a
 * failed build) the package's island class by NI-2's report decides
 * instead: runtime (R1) or object-model (R2). `--node-islands=auto` only;
 * null for none. */
function fenceIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  lowered: LowerResult,
  known: ReadonlyMap<string, IslandPackage>,
  requireFence = true,
  sure?: Set<string>,
): Map<string, IslandPackage> | null {
  if (fe.nodeIslandScan === undefined) return null;
  if (requireFence && lowered.runtimeFences.length === 0) return null;
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 32) return null;
  // An explicit --npm-static request keeps its package native.
  const explicit = new Set(
    Array.isArray(opts.npmStatic) ? opts.npmStatic.map((n) => n.replace(/\.\.\.$/, "")) : [],
  );
  const compiled = new Set(
    fe.npmStatic
      .filter((e) => e.status === "static" && !explicit.has(e.package))
      .map((e) => e.package),
  );
  const fenced = new Map<string, boolean>();
  for (const d of lowered.runtimeFences) {
    const at = packageDirOf(d.loc.file);
    if (at === null || !compiled.has(at.name) || known.has(at.name)) continue;
    if (policy.forcedNative.has(at.name) || policy.unloaded.has(at.name)) continue;
    // A fence in top-level module code throws when the module evaluates:
    // it counts like one that needs the runtime.
    const runtime = d.moduleInit === true || classifyDiagnostic(d, "fence").class === "runtime";
    fenced.set(at.name, (fenced.get(at.name) ?? false) || runtime);
    if (runtime) sure?.add(at.name);
  }
  if (requireFence && fenced.size === 0) return null;
  const scan = fe.nodeIslandScan({ userJs: false });
  const report = buildNodeIslandReport({
    entry: entryPath,
    scan,
    npm: fe.npmStatic,
    diagnostics: lowered.diagnostics,
    fences: lowered.runtimeFences,
    policy,
  });
  const grown = new Map(known);
  for (const island of report.islands) {
    const runtimeFence = requireFence
      ? fenced.get(island.package)
      : (fenced.get(island.package) ?? false);
    if (runtimeFence === undefined || island.path === null) continue;
    if (!compiled.has(island.package) || known.has(island.package)) continue;
    if (policy.forcedNative.has(island.package) || policy.unloaded.has(island.package)) continue;
    // With fences (requireFence), only fences that surely fire count: a
    // gap fence inside a function body may never run (jose's typed paths
    // stay native, DECISIONS.md 2026-10-21). After a failed build
    // (!requireFence), the package's report class decides.
    if (requireFence && !runtimeFence) continue;
    if (!runtimeFence && island.class !== "runtime" && island.class !== "object-model") continue;
    grown.set(island.package, {
      name: island.package,
      version: island.version,
      dir: island.path,
      class: island.class,
      reason: island.reason,
    });
  }
  // A native ES module that imports an island CommonJS module would read
  // its bindings from the module's exports object, where Node gives it the
  // namespace its CommonJS facade builds (the lexed names, module.exports
  // as the default): the importing package runs in the island too.
  for (let added = true; added;) {
    added = false;
    for (const edge of scan.edges) {
      const name = edge.to;
      if (!grown.has(name) || edge.fromDir === null || edge.shim) continue;
      const at = packageDirOf(edge.fromFile);
      if (at === null || grown.has(at.name) || !compiled.has(at.name)) continue;
      if (policy.forcedNative.has(at.name) || policy.unloaded.has(at.name)) continue;
      if (!isEsmFile(edge.fromFile)) continue;
      const target =
        resolveBareModule(edge.fromFile, name, "js-only") ??
        resolveBareModule(edge.fromFile, name, "js-only", "require");
      if (target === null || isEsmFile(target.typesFile)) continue;
      grown.set(at.name, {
        name: at.name,
        version: packageVersionOf(at.dir),
        dir: at.dir,
        class: "packaging",
        reason: `an ES module of the package imports the CommonJS island package '${name}'`,
      });
      // It goes wherever that island goes, the sure-fence retry included.
      if (known.has(name) || sure?.has(name) === true) sure?.add(at.name);
      added = true;
    }
  }
  return grown.size === known.size ? null : grown;
}
