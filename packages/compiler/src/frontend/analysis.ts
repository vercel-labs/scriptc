import { packageNameOfSpecifier } from "./workspace-registry.js";
import { npmStaticRefusalDiag } from "../diagnostics/diagnostic.js";
import type { AnalyzeOptions, AnalyzeResult } from "../compile-types.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { provenanceSources } from "./provenance-registry.js";
import type { FrontendFactory } from "./pipeline.js";
import { readProjectConfig } from "../project-config.js";
import { nodeIslandPolicy } from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import { hasNodeIslandFindings } from "../node-islands/summary.js";

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
  const fe = createFrontend(entryPath, opts.npmStatic, opts.externalTypes, undefined, {
    nodeIslands: true,
  });
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
    // Coverage is whole-program by design: builds stop at what the entry
    // reaches, but the analysis additionally lowers the unreached remainder
    // (throwaway) so the report covers everything the source declares — with
    // the unreached share in its own group.
    const lowered = fe.lower({
      coverage: true,
      targetPlatform: buildPlatform,
      ...(ffi !== null ? { ffiImports: ffi.functions } : {}),
      ...(opts.tier !== undefined ? { tierMode: opts.tier } : {}),
      ...(opts.explainDynamic === true ? { tierReport: { preflight } } : {}),
      ...(opts.wasm !== undefined && opts.wasm.length > 0 ? { wasmFiles: opts.wasm } : {}),
    });
    const provenance = provenanceSources();
    // Node islands, report-only: which packages and modules would run in
    // Node, from the detector's scan and the policy. Code generation does
    // not depend on it.
    const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
    const islandReport =
      fe.nodeIslandScan === undefined
        ? null
        : buildNodeIslandReport({
            entry: entryPath,
            scan: fe.nodeIslandScan({ userJs: policy.strictUserJs }),
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
      sourceTexts: fe.sourceTexts(),
    };
  } finally {
    fe.dispose();
  }
}
