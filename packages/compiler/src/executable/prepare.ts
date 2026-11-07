import type { CompileFailure, CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { frontendDisposed } from "../frontend/dispose-hook.js";
import {
  checkerPanicDiag,
  nodeIslandBuildFailedDiag,
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
import type { IslandModule, IslandPackage } from "../node-islands/boundary.js";
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
  type GrownIslands,
  type IslandGrowthContext,
} from "../node-islands/growth.js";

export interface PreparedExecutableModule {
  ok: true;
  mod: IrModule;
  sourceTexts: Map<string, string>;
  stats: LowerStats;
  /** Divergence warnings (SC6xxx): the build succeeds; these sites can
   * behave differently from Node. */
  warnings: ScrDiagnostic[];
  /** The Node islands the build ran (the SC8001 notes name them with their
   * reasons): packages by name, modules by file. A cached build repeats
   * them. */
  islands?: { packages: string[]; modules: string[] };
}

/** Release the parser/checker before native object generation begins.
 * `unitStore` keeps the lowered units of this build for the next one
 * (unit-reuse.ts).
 *
 * The island set grows between rounds (node-islands/growth.ts): each round
 * loads and lowers the program with the set the rounds before it decided
 * (`lowerIslands`, `lowerModules`), and the last round's outcome is the
 * build's. `explain` is true until the one retry a failed lowering gets from
 * the packages' island classes has run. `fenced` holds the packages the
 * rounds so far moved into islands for their runtime fences, which a
 * failure names (SC8023). */
export function prepareExecutableModule(
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: CompilationTiming = () => {},
  lowerIslands: ReadonlyMap<string, IslandPackage> = new Map(),
  explain = true,
  unitStore: UnitStore | null = null,
  lowerModules: ReadonlyMap<string, IslandModule> = new Map(),
  fenced: ReadonlyMap<string, FencedPackage> = new Map(),
): PreparedExecutableModule | CompileFailure {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  // The island decision reads the detector's scan unless islands are off.
  const islandScan = policy.mode !== "off";
  let fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, { islandScan });
  timing("frontend-load");
  // Node islands (scope-B NI-4): packages refused natively run in Node,
  // unless the policy says otherwise. The frontend reloads without them,
  // so their declarations type the program.
  const islandDecision = decideNodeIslands(entryPath, opts, fe, lowerIslands, lowerModules);
  // A patched builtin the native build cannot represent (an entry module
  // patch, or a native read of a patched member) fails here.
  if (islandDecision !== null && islandDecision.errors.length > 0) {
    const diagnostics = islandDecision.errors;
    const sourceTexts = fe.sourceTexts();
    fe.dispose();
    return { ok: false, diagnostics, sourceTexts };
  }
  if (islandDecision !== null) {
    fe.dispose();
    fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, {
      islandPackages: new Set(islandDecision.packages.keys()),
      ...(islandDecision.modules.size > 0
        ? { islandModules: new Set(islandDecision.modules.keys()) }
        : {}),
      islandScan,
    });
    // The round's island set, by package name: the decision a build's timing
    // log shows per round.
    timing("frontend-island-reload", {
      islands: [...islandDecision.packages.keys()].sort(),
      modules: islandDecision.modules.size,
    });
  }
  let lowered: LowerResult;
  let sourceTexts: Map<string, string>;
  let contractWarnings: ScrDiagnostic[] = [];
  let deferredWarnings: ScrDiagnostic[] = [];
  let disposed = false;
  // The growth inputs this build's frontend offers (node-islands/growth.ts).
  // Built once: the frontend does not change inside a build, and its scan is
  // a whole-program walk.
  let growthInputs: IslandGrowthContext | null = null;
  let growthBuilt = false;
  const growthOf = (): IslandGrowthContext | null => {
    if (!growthBuilt) {
      growthInputs = islandGrowth(entryPath, opts, fe);
      growthBuilt = true;
    }
    return growthInputs;
  };
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    // A failure of a build that moved packages into islands for their
    // runtime fences names them last (SC8023): the errors above it are the
    // island build's, and the note says how to keep the packages native.
    const fail = (diagnostics: ScrDiagnostic[]): CompileFailure => ({
      ok: false,
      diagnostics:
        fenced.size === 0
          ? diagnostics
          : [
              ...diagnostics,
              nodeIslandBuildFailedDiag(
                [...fenced].map(([name, entry]) => ({
                  name,
                  count: entry.count,
                  first: entry.first,
                })),
                { file: entryPath, start: 0, end: 0 },
              ),
            ],
      sourceTexts: fe.sourceTexts(),
    });
    // The next round: the same build with a grown island set.
    const retry = (
      islands: ReadonlyMap<string, IslandPackage>,
      modules: ReadonlyMap<string, IslandModule>,
      grown: GrownIslands | null,
      store: UnitStore | null,
    ): PreparedExecutableModule | CompileFailure => {
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
        islands,
        explain && grown?.explained !== true,
        store,
        modules,
        grown === null || grown.fenced.size === 0 ? fenced : new Map([...fenced, ...grown.fenced]),
      );
    };

    // A package already bound to a Node island is never compiled statically,
    // so a refusal status it still carries is the bookkeeping of the analysis
    // that islanded it (the entry-join check runs before islanding is
    // applied). The island boundary owns it: a package that cannot actually
    // run in Node fails there, with the island's own diagnostic.
    const islanded = islandedPackages(lowerIslands, islandDecision);
    const refused = fe.npmStatic.filter(
      (entry) => entry.status === "refused" && !islanded.has(entry.package),
    );
    if (refused.length > 0) {
      // A refusal the island decision could not place — one discovered
      // before the package joined the type-checked program is missing from
      // the detector's report and can fall outside its fallback resolution
      // too (the `retry`/`proper-lockfile` shape) — is islanded here under
      // the automatic policy, and the program is analysed once more.
      const late = refusalIslands(entryPath, opts, fe, refused, islanded);
      if (late !== null) return retry(late, lowerModules, null, unitStore);
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
      const growth = growthOf();
      const grown =
        growth === null ? null : growIslandSet(growth, lowerIslands, { preflight: fe.preflight });
      if (grown !== null) return retry(grown.packages, lowerModules, grown, unitStore);
      return fail(fe.preflight);
    }

    try {
      lowered = fe.lower(
        {
          ...(islandDecision !== null ? { nodeIslands: islandDecision } : {}),
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
    // A package the fence rule would run in Node (growth.ts) that the policy
    // keeps native (a package marked native, or islands limited to marked
    // ones or off) is a refusal of the build, not a throw it ships: SC8003
    // or SC8002, with the lowering's own errors.
    const violations = fenceViolations(
      entryPath,
      policy,
      fe.npmStatic,
      Array.isArray(opts.npmStatic) ? opts.npmStatic : undefined,
      fe.npmImportSites,
      lowered.runtimeFences,
    );
    if (lowered.module === null) {
      // Packages whose own modules refused to lower, and packages the
      // lowering reached a runtime fence in, run in Node islands (the
      // authoritative lowering, DESIGN.md §1.4): build again with them as
      // islands. When no rule places the failure and the explained retry
      // has not run, the packages whose class is the runtime or a mutable
      // object model run in Node for one more build, whose failure is then
      // the one reported.
      // Sloppy user modules the lowering refused join the same retry
      // (DESIGN.md note 1 §3.2): one reload with every island at once,
      // never one round per module.
      const grownModules = loweringModules(entryPath, opts, lowered.diagnostics, lowerModules);
      const growth = growthOf();
      const grown =
        growth === null
          ? null
          : growIslandSet(growth, lowerIslands, {
              diagnostics: lowered.diagnostics,
              fences: lowered.runtimeFences,
              explain: explain && grownModules === null,
            });
      // The explained retry lowers a differently typed program: none of
      // this round's units carry over.
      if (grown !== null || grownModules !== null)
        return retry(
          grown?.packages ?? lowerIslands,
          grownModules ?? lowerModules,
          grown,
          grown?.explained === true ? null : unitStore,
        );
      return fail([...lowered.diagnostics, ...violations]);
    }
    if (violations.length > 0) return fail(violations);
    // A lowering that succeeded with runtime fences the fence rule islands
    // their packages for: those packages run in Node islands, and the build
    // with them there replaces this one. There is no way back: when it
    // fails, the build fails with its errors and SC8023, never with the
    // throws this round compiled.
    const growth = growthOf();
    const fenceGrown =
      growth === null
        ? null
        : growIslandSet(growth, lowerIslands, {
            diagnostics: lowered.diagnostics,
            fences: lowered.runtimeFences,
          });
    if (fenceGrown !== null) return retry(fenceGrown.packages, lowerModules, fenceGrown, unitStore);
    // The packages that stay native with fences the program can reach: the
    // build ships those throws, and says so (SC6006).
    deferredWarnings = deferredFenceWarnings(
      entryPath,
      policy,
      fe.npmStatic,
      Array.isArray(opts.npmStatic) ? opts.npmStatic : undefined,
      fe.npmImportSites,
      lowered.runtimeFences,
      islandedPackages(lowerIslands, islandDecision),
    );

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
      contractWarnings = checked.warnings;
    }
  } finally {
    if (!disposed) {
      fe.dispose();
      frontendDisposed();
      timing("frontend-dispose");
    }
  }

  return {
    ok: true,
    mod: lowered.module!,
    sourceTexts,
    stats: lowered.stats,
    warnings: [
      ...(islandDecision?.notes ?? []),
      ...(fe.warnings ?? []),
      ...(lowered.divergences ?? []),
      ...deferredWarnings,
      ...(lowered.performance ?? []),
      ...contractWarnings,
    ],
    ...(islandDecision === null
      ? {}
      : {
          islands: {
            packages: [...islandDecision.packages.keys()].sort(),
            modules: [...islandDecision.modules.keys()].sort(),
          },
        }),
  };
}
