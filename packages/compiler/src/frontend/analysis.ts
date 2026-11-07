import { packageNameOfSpecifier } from "./workspace-registry.js";
import {
  nodeIslandBuildFailedDiag,
  npmStaticRefusalDiag,
  type ScrDiagnostic,
} from "../diagnostics/diagnostic.js";
import type { AnalyzeOptions, AnalyzeResult } from "../compile-types.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { provenanceSources } from "./provenance-registry.js";
import type { Frontend, FrontendFactory } from "./pipeline.js";
import type { LowerResult } from "./lowering/lowerer.js";
import { readProjectConfig } from "../project-config.js";
import type { IslandModule, IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import { nodeIslandPolicy } from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import { hasNodeIslandFindings } from "../node-islands/summary.js";
import {
  decideNodeIslands,
  islandGrowth,
  islandedPackages,
  loweringModules,
  refusalIslands,
} from "../node-islands/decide.js";
import {
  deferredFenceWarnings,
  fenceViolations,
  growIslandSet,
  type FencedPackage,
} from "../node-islands/growth.js";

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
  // The first load keeps the whole program, as each round of a build's does:
  // the island decision classifies every package from it (node-islands/
  // decide.ts), including a package the policy forces into Node.
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  const fe = scanOnce(
    createFrontend(entryPath, opts.npmStatic, opts.externalTypes, undefined, {
      nodeIslands: true,
    }),
  );
  // The reload a round lowers on, once its island set is known (see
  // roundFrontend): null while the first load already excludes every island.
  const lowerLoad: { fe: Frontend | null; key: string } = { fe: null, key: "" };
  try {
    const emptyStats = {
      statementsTotal: 0,
      statementsFailed: 0,

      functionsSkipped: 0,
    };
    const external = (pkg: string): boolean =>
      Object.keys(opts.externalTypes ?? {}).some(
        (specifier) => packageNameOfSpecifier(specifier) === pkg,
      );
    const refusalDiag = (front: Frontend, entry: NpmStaticStatus): ScrDiagnostic =>
      npmStaticRefusalDiag(
        entry.package,
        entry.detail ?? "its static compilation was refused",
        front.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 },
        entry.hint,
      );
    const stopped = (front: Frontend, diagnostics: ScrDiagnostic[]): AnalyzeResult => ({
      coverage: {
        file: entryPath,
        stats: emptyStats,
        diagnostics,
        ...(fe.npmStatic.length > 0 ? { npmStatic: fe.npmStatic } : {}),
        preflightFailed: true,
      },
      sourceTexts:
        front === fe ? fe.sourceTexts() : new Map([...fe.sourceTexts(), ...front.sourceTexts()]),
    });
    // Import-FORM fences don't stop the analysis: the module graph is still
    // computable (a fenced import contributes no edges), the imported
    // bindings poison at their use sites, and the fences join the blockers
    // list beside statement-level ones — the report shows a statement
    // percentage instead of stopping at the import lines. Everything else —
    // tsc errors, config incompatibilities, circular imports — still stops
    // at preflight (no trustworthy program to lower). Builds are unchanged:
    // compile() fails on every preflight diagnostic exactly as before.
    const IMPORT_FENCES = new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015", "SC2013"]);
    // The frontend a round lowers on. A package the first load compiled but
    // the round islands is not part of the compiled program, and neither is
    // an island module: the reload keeps their implementations out of the
    // graph and types their values as island handles, exactly as the build's
    // island reload does (executable/prepare.ts). A refused package was never
    // in the program, so a set of those alone needs no reload.
    const roundFrontend = (islands: NodeIslandSet | null): Frontend => {
      const packages = islands === null ? [] : [...islands.packages.keys()].sort();
      const modules = islands === null ? [] : [...islands.modules.keys()].sort();
      const compiled = packages.filter((name) =>
        fe.npmStatic.some((e) => e.package === name && e.status === "static"),
      );
      if (compiled.length === 0 && modules.length === 0) return fe;
      const key = `${packages.join("\n")}\n\n${modules.join("\n")}`;
      if (lowerLoad.fe === null || key !== lowerLoad.key) {
        lowerLoad.fe?.dispose();
        lowerLoad.fe = scanOnce(
          createFrontend(entryPath, opts.npmStatic, opts.externalTypes, undefined, {
            nodeIslands: true,
            islandPackages: new Set(packages),
            ...(modules.length > 0 ? { islandModules: new Set(modules) } : {}),
          }),
        );
        lowerLoad.key = key;
      }
      return lowerLoad.fe;
    };
    const lowerWith = (
      front: Frontend,
      islands: NodeIslandSet | null,
      preflight: ScrDiagnostic[],
    ): LowerResult => {
      const islandsActive =
        islands !== null && (islands.packages.size > 0 || islands.modules.size > 0);
      return front.lower({
        coverage: true,
        targetPlatform: buildPlatform,
        ...(islandsActive ? { nodeIslands: islands } : {}),
        ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
        ...(opts.tier !== undefined ? { tierMode: opts.tier } : {}),
        ...(opts.explainDynamic === true ? { tierReport: { preflight } } : {}),
        ...(opts.wasm !== undefined && opts.wasm.length > 0 ? { wasmFiles: opts.wasm } : {}),
      });
    };
    // Node islands. The analysis makes the build's island decision, round by
    // round, with the build's own functions (node-islands/decide.ts and
    // growth.ts, in the order executable/prepare.ts runs them): the
    // first-load decision, the refusals a load still has to place, the
    // preflight rule, the lowering, and the growth from what the lowering
    // saw. Each round lowers with the set the rounds before it decided; the
    // last round is what a build compiles, so its diagnostics are the
    // build's and its island set is the one the report names. Coverage is
    // whole-program by design: where a build stops (import fences, lowering
    // refusals) the analysis goes on, and additionally lowers the unreached
    // remainder (throwaway) so the report covers everything the source
    // declares — with the unreached share in its own group.
    let lowerIslands: ReadonlyMap<string, IslandPackage> = new Map();
    let lowerModules: ReadonlyMap<string, IslandModule> = new Map();
    let explain = true;
    const fenced = new Map<string, FencedPackage>();
    // The pass that grew the set named the packages; the reload no longer
    // compiles them, so its diagnostics do not. Their first reasons stay the
    // island report's (the same reasons a build's SC8001 note keeps).
    const growthReasons: ScrDiagnostic[] = [];
    const growthFences: ScrDiagnostic[] = [];
    const explicitStatic = Array.isArray(opts.npmStatic) ? opts.npmStatic : undefined;
    let decision: ReturnType<typeof decideNodeIslands> = null;
    let front: Frontend = fe;
    let preflight: ScrDiagnostic[] = [];
    let violations: ScrDiagnostic[] = [];
    let lowered: LowerResult;
    for (;;) {
      decision = decideNodeIslands(entryPath, opts, fe, lowerIslands, lowerModules);
      // A patched builtin the native build cannot represent fails a build
      // before anything is lowered.
      if (decision !== null && decision.errors.length > 0) return stopped(fe, decision.errors);
      front = roundFrontend(decision);
      // The round's island set, as a build's timing log shows it per round
      // (executable/prepare.ts's frontend-island-reload).
      if (process.env["SCRIPTC_TIMING"] === "1") {
        process.stderr.write(
          `scriptc coverage ${JSON.stringify({
            phase: "island-round",
            islands: decision === null ? [] : [...decision.packages.keys()].sort(),
            modules: decision === null ? 0 : decision.modules.size,
          })}\n`,
        );
      }
      const islanded = islandedPackages(lowerIslands, decision);
      // A refused package no island binds is a refusal of the build.
      const refused = front.npmStatic.filter(
        (entry) =>
          entry.status === "refused" && !islanded.has(entry.package) && !external(entry.package),
      );
      if (refused.length > 0) {
        const late = refusalIslands(entryPath, opts, front, refused, islanded);
        if (late !== null) {
          lowerIslands = late;
          continue;
        }
      }
      const growth = islandGrowth(entryPath, opts, front);
      if (front.preflight.length > 0 && growth !== null) {
        const grown = growIslandSet(growth, lowerIslands, { preflight: front.preflight });
        if (grown !== null) {
          lowerIslands = grown.packages;
          continue;
        }
      }
      preflight = [...front.preflight, ...refused.map((entry) => refusalDiag(front, entry))];
      if (preflight.some((d) => !IMPORT_FENCES.has(d.code))) return stopped(front, preflight);
      lowered = lowerWith(front, decision, preflight);
      // A package the fence rule islands that the policy keeps native fails
      // a build (SC8002, SC8003).
      violations = fenceViolations(
        entryPath,
        policy,
        front.npmStatic,
        explicitStatic,
        front.npmImportSites,
        lowered.runtimeFences,
      );
      const failed = lowered.diagnostics.length > 0;
      const grownModules = failed
        ? loweringModules(entryPath, opts, lowered.diagnostics, lowerModules)
        : null;
      const grown =
        growth === null
          ? null
          : growIslandSet(growth, lowerIslands, {
              diagnostics: lowered.diagnostics,
              fences: lowered.runtimeFences,
              explain: failed && explain && grownModules === null,
            });
      if (grown === null && grownModules === null) break;
      growthReasons.push(...lowered.diagnostics);
      growthFences.push(...lowered.runtimeFences);
      if (grown !== null) {
        lowerIslands = grown.packages;
        for (const [name, entry] of grown.fenced) fenced.set(name, entry);
        if (grown.explained) explain = false;
      }
      if (grownModules !== null) lowerModules = grownModules;
    }
    // What fails a build beyond the lowering's own diagnostics: the policy
    // violations, and after a round that moved packages into islands for
    // their fences, the note that names them (SC8023).
    const buildFails = preflight.length > 0 || lowered.diagnostics.length > 0;
    const trailing: ScrDiagnostic[] = [...violations];
    if ((buildFails || violations.length > 0) && fenced.size > 0)
      trailing.push(
        nodeIslandBuildFailedDiag(
          [...fenced].map(([name, entry]) => ({ name, count: entry.count, first: entry.first })),
          { file: entryPath, start: 0, end: 0 },
        ),
      );
    // The packages a build keeps native with fences the program can reach
    // (SC6006), beside the lowering's own divergences.
    const divergences = [
      ...(lowered.divergences ?? []),
      ...deferredFenceWarnings(
        entryPath,
        policy,
        front.npmStatic,
        explicitStatic,
        front.npmImportSites,
        lowered.runtimeFences,
        islandedPackages(lowerIslands, decision),
      ),
    ];
    const scan = fe.nodeIslandScan?.({ userJs: policy.strictUserJs });
    const provenance = provenanceSources();
    const islandReport =
      scan === undefined
        ? null
        : buildNodeIslandReport({
            entry: entryPath,
            scan,
            npm: fe.npmStatic,
            diagnostics: distinctDiagnostics([
              growthReasons,
              lowered.diagnostics,
              lowered.unreached?.diagnostics ?? [],
            ]),
            fences: distinctDiagnostics([
              growthFences,
              lowered.runtimeFences,
              lowered.unreached?.runtimeFences ?? [],
            ]),
            policy,
            decided: {
              packages: decision?.packages ?? new Map(),
              modules: decision?.modules ?? new Map(),
            },
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
        diagnostics: [
          ...preflight,
          ...lowered.diagnostics,
          ...trailing,
          ...(nodeIslands?.userJs ?? []),
        ],
        ...(lowered.runtimeFences.length > 0 ? { runtimeFences: lowered.runtimeFences } : {}),
        ...(divergences.length > 0 ? { divergences } : {}),
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

/** `fe` with its island scan answered once per `userJs`: the decision asks
 * the first load for the same whole-program walk in every round. */
function scanOnce(fe: Frontend): Frontend {
  const scan = fe.nodeIslandScan;
  if (scan === undefined) return fe;
  const answers = new Map<boolean, ReturnType<typeof scan>>();
  return {
    ...fe,
    nodeIslandScan: (options) => {
      let answer = answers.get(options.userJs);
      if (answer === undefined) answers.set(options.userJs, (answer = scan(options)));
      return answer;
    },
  };
}

/** Every pass's diagnostics, once each: a package a later pass still
 * refuses reports the same site again. */
function distinctDiagnostics(passes: readonly ScrDiagnostic[][]): ScrDiagnostic[] {
  const seen = new Set<string>();
  const out: ScrDiagnostic[] = [];
  for (const pass of passes) {
    for (const d of pass) {
      const key = `${d.code}\u0000${d.loc.file}\u0000${d.loc.start}\u0000${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}
