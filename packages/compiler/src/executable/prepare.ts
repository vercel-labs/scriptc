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
import type { CompilationTiming } from "../timing.js";
import { readProjectConfig } from "../project-config.js";
import { nodeIslandPolicy } from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import type { IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import { classifyDiagnostic, isIslandReasonCode } from "../node-islands/classify.js";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import { describe } from "../node-islands/summary.js";
import { resolveBareModule } from "../frontend/resolve.js";

export interface PreparedExecutableModule {
  ok: true;
  mod: IrModule;
  sourceTexts: Map<string, string>;
  stats: LowerStats;
  /** Divergence warnings (SC6xxx): the build succeeds; these sites can
   * behave differently from Node. */
  warnings: ScrDiagnostic[];
}

/** Release the parser/checker before native object generation begins. */
export function prepareExecutableModule(
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: CompilationTiming = () => {},
  lowerIslands: ReadonlyMap<string, IslandPackage> = new Map(),
  retryFences = true,
): PreparedExecutableModule | CompileFailure {
  let fe = createFrontend(entryPath, opts.npmStatic);
  timing("frontend-load");
  // Node islands (scope-B NI-4): packages refused natively run in Node,
  // unless the policy says otherwise. The frontend reloads without them,
  // so their declarations type the program.
  const islandDecision = decideNodeIslands(entryPath, opts, fe, lowerIslands);
  if (islandDecision !== null) {
    fe.dispose();
    fe = createFrontend(
      entryPath,
      opts.npmStatic,
      undefined,
      undefined,
      new Set(islandDecision.packages.keys()),
    );
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
        );
      }
      return fail(fe.preflight);
    }

    try {
      lowered = fe.lower({
        ...(islandDecision !== null ? { nodeIslands: islandDecision } : {}),
        targetPlatform: buildPlatform,
        ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
        ...(opts.tier !== undefined ? { tierMode: opts.tier } : {}),
      });
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
      const grown = loweringIslands(entryPath, opts, fe, lowered.diagnostics, lowerIslands);
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
        );
      }
      // A failed program whose compiled packages need the runtime or a
      // mutable object model (NI-2's report): try them as islands, and
      // report this failure if that build fails too.
      const marked = retryFences
        ? fenceIslands(entryPath, opts, fe, lowered, lowerIslands, false)
        : null;
      if (marked !== null) {
        const diagnostics = lowered.diagnostics;
        const texts = fe.sourceTexts();
        fe.dispose();
        frontendDisposed();
        disposed = true;
        const islanded = prepareExecutableModule(
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          marked,
          false,
        );
        if (islanded.ok) return islanded;
        return { ok: false, diagnostics, sourceTexts: texts };
      }
      return fail(lowered.diagnostics);
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
  const refused = new Set(
    policy.mode === "auto"
      ? fe.npmStatic.filter((e) => e.status === "refused").map((e) => e.package)
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
  const report = buildNodeIslandReport({
    entry: entryPath,
    scan: fe.nodeIslandScan({ userJs: false }),
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
  return grown.size === known.size ? null : grown;
}
