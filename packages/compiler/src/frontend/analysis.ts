import { packageNameOfSpecifier } from "./workspace-registry.js";
import { npmStaticRefusalDiag, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import type { AnalyzeOptions, AnalyzeResult } from "../compile-types.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { provenanceSources } from "./provenance-registry.js";
import type { Frontend, FrontendFactory } from "./pipeline.js";
import type { LowerResult } from "./lowering/lowerer.js";
import { resolveBareModule } from "./resolve.js";
import { readProjectConfig } from "../project-config.js";
import type { IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import { nodeIslandPolicy, type NodeIslandPolicy } from "../node-islands/policy.js";
import { buildNodeIslandReport, reportIslandSet } from "../node-islands/report.js";
import { hasNodeIslandFindings } from "../node-islands/summary.js";
import { outsideGraphIslands } from "../node-islands/graph-islands.js";

/** Analysis without codegen: how much of the program compiles statically.
 * Unlike compile(), lowering diagnostics are data here, not failure. */
export function analyzeWithFrontend(
  entryPath: string,
  opts: AnalyzeOptions,
  buildPlatform: string,
  createFrontend: FrontendFactory,
): AnalyzeResult {
  let ffi: FfiProfile | null = null;
  if (opts.ffiProfilePath !== undefined) {
    const loaded = loadFfiProfile(opts.ffiProfilePath);
    if (!loaded.ok) {
      return {
        coverage: {
          file: entryPath,
          stats: {
            statementsTotal: 0,
            statementsFailed: 0,

            functionsSkipped: 0,
          },
          diagnostics: loaded.diagnostics,
          preflightFailed: true,
        },
        sourceTexts: new Map(),
      };
    }
    ffi = loaded.profile;
  }
  // The first load keeps the whole program, as a build's first load does: the
  // island report classifies every package from it (executable/prepare.ts's
  // decideNodeIslands), including a package the policy forces into Node.
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  const fe = createFrontend(entryPath, opts.npmStatic, opts.externalTypes, undefined, {
    nodeIslands: true,
  });
  // The reload lowering may run on, once the island set is known (see
  // lowerFrontend): null when the first load already excludes every island.
  const lowerLoad: { fe: Frontend | null; key: string } = { fe: null, key: "" };
  try {
    const emptyStats = {
      statementsTotal: 0,
      statementsFailed: 0,

      functionsSkipped: 0,
    };

    const preflight = [
      ...fe.preflight,
      ...fe.npmStatic
        .filter(
          (entry) =>
            entry.status === "refused" &&
            !Object.keys(opts.externalTypes ?? {}).some(
              (specifier) => packageNameOfSpecifier(specifier) === entry.package,
            ),
        )
        .map((entry) =>
          npmStaticRefusalDiag(
            entry.package,
            entry.detail ?? "its static compilation was refused",
            fe.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 },
            entry.hint,
          ),
        ),
    ];
    // Import-FORM fences don't stop the analysis: the module graph is still
    // computable (a fenced import contributes no edges), the imported
    // bindings poison at their use sites, and the fences join the blockers
    // list beside statement-level ones — the report shows a statement
    // percentage instead of stopping at the import lines. Everything else —
    // tsc errors, config incompatibilities, circular imports — still stops
    // at preflight (no trustworthy program to lower). Builds are unchanged:
    // compile() fails on every preflight diagnostic exactly as before.
    const IMPORT_FENCES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015", "SC2013"]);
    if (preflight.some((d) => !IMPORT_FENCES.has(d.code))) {
      return {
        coverage: {
          file: entryPath,
          stats: emptyStats,
          diagnostics: preflight,
          ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
          preflightFailed: true,
        },
        sourceTexts: fe.sourceTexts(),
      };
    }
    // Node islands, report-only: which packages and modules would run in
    // Node, from the detector's scan and the policy. Code generation does
    // not depend on it, but LOWERING does: a package a build runs in Node is
    // typed by its declarations, and its values are island handles there.
    // The analysis lowers with that same set, so a site a build resolves
    // through an island is not reported as a refusal (a `config.region = …`
    // on a refused SDK's config object is a dynamic property write in the
    // build, not "assignment to non-variables"). The set is the report's
    // decision for the packages a build actually islands, taken from the load
    // before lowering exactly as a build takes it (executable/prepare.ts's
    // decideNodeIslands).
    // The packages a build islands (executable/prepare.ts's decideNodeIslands):
    // the ones whose static compilation was refused, or that the policy marks.
    // The report's other islands are would-be (it lists the islands a build
    // would choose for packages it compiles natively today); lowering with
    // those would report refusals for code the build compiles.
    const refused = new Set(
      policy.mode === "auto"
        ? fe.npmStatic
            .filter((e) => e.status === "refused" && !policy.forcedNative.has(e.package))
            .map((e) => e.package)
        : [],
    );
    // One scan of the program decides every island question below: the
    // lowering's set, the graph-proven growth of it, and the final report.
    const scan = fe.nodeIslandScan?.({ userJs: policy.strictUserJs });
    const lowerIslands =
      scan === undefined
        ? null
        : reportIslandSet(
            buildNodeIslandReport({
              entry: entryPath,
              scan,
              npm: fe.npmStatic,
              diagnostics: [],
              fences: [],
              policy,
            }),
            (name) => refused.has(name) || policy.forcedNode.has(name),
            (name) => islandPackageDir(fe, entryPath, name),
          );
    // Coverage is whole-program by design: builds stop at what the entry
    // reaches, but the analysis additionally lowers the unreached remainder
    // (throwaway) so the report covers everything the source declares — with
    // the unreached share in its own group.
    // The frontend lowering runs on. A package the first load compiled but a
    // build islands is not part of the compiled program: the reload's
    // islandPackages keeps its implementation out of the graph and types its
    // values as island handles, exactly as the build's island reload does
    // (executable/prepare.ts). Lowering the first load's program would report
    // refusals from code the build excludes. A refused package was never in
    // the program, so it needs no reload.
    const lowerFrontend = (islands: NodeIslandSet | null): Frontend => {
      const packages = islands === null ? [] : [...islands.packages.keys()].sort();
      const compiled = packages.filter((name) =>
        fe.npmStatic.some((e) => e.package === name && e.status === "static"),
      );
      if (compiled.length === 0) return fe;
      const key = packages.join("\n");
      if (lowerLoad.fe === null || key !== lowerLoad.key) {
        lowerLoad.fe?.dispose();
        lowerLoad.fe = createFrontend(entryPath, opts.npmStatic, opts.externalTypes, undefined, {
          nodeIslands: true,
          islandPackages: new Set(packages),
        });
        lowerLoad.key = key;
      }
      return lowerLoad.fe;
    };
    const lowerWith = (islands: NodeIslandSet | null): LowerResult => {
      const islandsActive = islands !== null && islands.packages.size > 0;
      return lowerFrontend(islands).lower({
        coverage: true,
        targetPlatform: buildPlatform,
        ...(islandsActive ? { nodeIslands: islands } : {}),
        ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
        ...(opts.tier !== undefined ? { tierMode: opts.tier } : {}),
        ...(opts.explainDynamic === true ? { tierReport: { preflight } } : {}),
        ...(opts.wasm !== undefined && opts.wasm.length > 0 ? { wasmFiles: opts.wasm } : {}),
      });
    };
    // A package the module graph proves runs in Node — a value import of an
    // installed package whose implementation the first load did not put in
    // the program — is exactly the SC2013 refusal the discovery lowering
    // would report and the retry below would then answer with an island.
    // Deciding it here makes the discovery lowering the retry lowering, so a
    // program pays one lowering instead of two
    // (node-islands/graph-islands.ts; executable/prepare.ts decides the same
    // set for builds). The retry stays for what only a lowering can see.
    let lowerIslandsLocal = lowerIslands;
    const proven =
      scan === undefined
        ? null
        : outsideGraphIslands(
            policy,
            fe.npmStatic,
            scan,
            lowerIslands?.modules ?? new Map(),
            lowerIslands?.packages ?? new Map(),
            // The analysis lowers every site, including the deferred require()
            // a build leaves to its retry, so those packages are refusals it
            // is about to report rather than decisions it may skip.
            true,
          );
    if (proven !== null) {
      const packages = new Map(lowerIslands?.packages ?? []);
      for (const [name, island] of proven) packages.set(name, island);
      lowerIslandsLocal = { packages, modules: lowerIslands?.modules ?? new Map() };
    }
    let lowered = lowerWith(lowerIslandsLocal);
    // A package the lowering refused (its implementation is not part of the
    // compiled module graph) runs in a Node island in a build, which lowers
    // again with it islanded (executable/prepare.ts's loweringIslands).
    // Coverage makes the same retry, so the refusals that package caused —
    // a property write on its config object, a call of its constructor, a
    // `for await` over its stream — are reported as what the build does
    // with them. The first pass's diagnostics stay the island report's
    // reasons: they named the packages, the retry cleared them.
    const grewFrom = lowered.diagnostics;
    for (
      let grown = grownIslands(entryPath, fe, policy, grewFrom, lowerIslandsLocal);
      grown !== null;
    ) {
      lowerIslandsLocal = grown;
      lowered = lowerWith(lowerIslandsLocal);
      grown = grownIslands(entryPath, fe, policy, lowered.diagnostics, lowerIslandsLocal);
    }
    const provenance = provenanceSources();
    const islandReport =
      scan === undefined
        ? null
        : buildNodeIslandReport({
            entry: entryPath,
            scan,
            npm: fe.npmStatic,
            diagnostics: [...lowered.diagnostics, ...(lowered.unreached?.diagnostics ?? [])],
            fences: [...lowered.runtimeFences, ...(lowered.unreached?.runtimeFences ?? [])],
            policy,
          });
    const nodeIslands =
      islandReport !== null && hasNodeIslandFindings(islandReport) ? islandReport : null;
    return {
      coverage: {
        file: entryPath,
        stats: lowered.stats,
        // The import fences report as blockers alongside the statement-level
        // ones (use sites of the fenced bindings emit matching diagnostics,
        // which the report groups with these).
        // --strict-user-js: R2 constructs in user JavaScript are blockers
        // (SC8101–SC8105), as scope B's builds will make them errors.
        diagnostics: [...preflight, ...lowered.diagnostics, ...(nodeIslands?.userJs ?? [])],
        ...(lowered.runtimeFences.length > 0 ? { runtimeFences: lowered.runtimeFences } : {}),
        ...(lowered.divergences !== undefined ? { divergences: lowered.divergences } : {}),
        ...(lowered.performance !== undefined ? { performance: lowered.performance } : {}),
        ...(lowered.dynamicSlots !== undefined ? { dynamicSlots: lowered.dynamicSlots } : {}),
        ...(lowered.unreached ? { unreached: lowered.unreached } : {}),
        ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
        // --provenance-sources: the per-package attribution inputs (the
        // report aggregates statsByFile under each package's source dir).
        ...(provenance !== null ? { provenance } : {}),
        ...(lowered.statsByFile ? { statsByFile: lowered.statsByFile } : {}),
        ...(lowered.provenanceElided ? { provenanceElided: lowered.provenanceElided } : {}),
        ...(lowered.tiers !== undefined ? { tiers: lowered.tiers } : {}),
        ...(lowered.wasmModules !== undefined ? { wasmModules: lowered.wasmModules } : {}),
        ...(nodeIslands !== null ? { nodeIslands } : {}),
        preflightFailed: false,
      },
      // The island reload's files are a subset of the first load's; merging
      // keeps both loads' texts for whatever a diagnostic names.
      sourceTexts:
        lowerLoad.fe === null
          ? fe.sourceTexts()
          : new Map([...fe.sourceTexts(), ...lowerLoad.fe.sourceTexts()]),
    };
  } finally {
    lowerLoad.fe?.dispose();
    fe.dispose();
  }
}

/** The installed directory of an islanded package whose implementation is
 * not part of the program: the report has no directory for it, and a build's
 * island decision resolves it from the importing site the same way
 * (executable/prepare.ts's decideNodeIslands). */
function islandPackageDir(
  fe: Frontend,
  entryPath: string,
  name: string,
  from?: string,
): string | null {
  // The refusing site's file first, as the build resolves it from the
  // diagnostic's own location, then the import site.
  const files = [from, fe.npmImportSites.get(name)?.file, entryPath].filter(
    (f): f is string => f !== undefined && f !== "",
  );
  let js: ReturnType<typeof resolveBareModule> = null;
  for (const file of files) {
    js =
      resolveBareModule(file, name, "js-only") ??
      resolveBareModule(file, name, "js-only", "require");
    if (js !== null) break;
  }
  const at = js === null ? null : packageDirOf(js.typesFile);
  return at !== null && at.name === name ? at.dir : null;
}

/** The island set grown by the packages the lowering said are not part of
 * its compiled module graph (executable/prepare.ts's loweringIslands, first
 * clause): a package named by an SC2013 refusal runs in a Node island in a
 * build, so the analysis lowers again with it islanded. Null when nothing
 * grows — no named package, auto policy off, or the same set the cap allows. */
function grownIslands(
  entryPath: string,
  fe: Frontend,
  policy: NodeIslandPolicy,
  diagnostics: readonly ScrDiagnostic[],
  known: NodeIslandSet | null,
): NodeIslandSet | null {
  if (policy.mode !== "auto") return null;
  const packages = known?.packages ?? new Map<string, IslandPackage>();
  if (packages.size > 16) return null;
  let grown: Map<string, IslandPackage> | null = null;
  for (const d of diagnostics) {
    if (d.code !== "SC2013") continue;
    const named = /npm package '([^']+)'/.exec(d.message);
    if (named === null) continue;
    const name = named[1]!;
    if (packages.has(name) || policy.forcedNative.has(name) || policy.unloaded.has(name)) continue;
    const dir = islandPackageDir(fe, entryPath, name, d.loc.file);
    if (dir === null) continue;
    grown ??= new Map(packages);
    grown.set(name, {
      name,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason: `${d.code}: ${d.message}`,
    });
  }
  if (grown === null) return null;
  return { packages: grown, modules: known?.modules ?? new Map() };
}
