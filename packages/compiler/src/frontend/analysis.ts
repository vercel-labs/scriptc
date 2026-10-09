import type { AnalyzeOptions, AnalyzeResult } from "../compile-types.js";
import { loadFfiProfile, type FfiProfile } from "../ffi/ffi-manifest.js";
import { provenanceSources } from "./provenance-registry.js";
import type { FrontendFactory } from "./pipeline.js";

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
          dynamic: opts.dynamic ?? false,
          stats: {
            statementsTotal: 0,
            statementsFailed: 0,
            statementsIsland: 0,
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
  const fe = createFrontend(entryPath, opts.npmStatic, opts.externalTypes);
  try {
    const emptyStats = {
      statementsTotal: 0,
      statementsFailed: 0,
      statementsIsland: 0,
      functionsSkipped: 0,
    };

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
      targetPlatform: buildPlatform,
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
        ...(lowered.divergences !== undefined ? { divergences: lowered.divergences } : {}),
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
