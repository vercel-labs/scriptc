import { readFileSync, realpathSync } from "node:fs";
import type { CompileFailure, CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { frontendDisposed } from "../frontend/dispose-hook.js";
import {
  checkerPanicDiag,
  nodeIslandEntryPatchDiag,
  nodeIslandEntryReadDiag,
  nodeIslandImplicitGlobalReadDiag,
  nodeIslandModuleNoteDiag,
  nodeIslandNoteDiag,
  nodeIslandReaderStripDiag,
  nodeIslandStripDiag,
  nodeIslandRetryFailedDiag,
  npmStaticRefusalDiag,
  nativePackageDiag,
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
import type { Frontend, FrontendFactory } from "../frontend/pipeline.js";
import { shapeOverlayEnabled } from "../frontend/shape-inference/index.js";
import type { NpmStaticStatus } from "../coverage/report.js";
import type { UnitStore } from "../frontend/lowering/unit-reuse.js";
import type { CompilationTiming } from "../timing.js";
import { readProjectConfig } from "../project-config.js";
import {
  isMarkedUserModule,
  nodeIslandPolicy,
  type NodeIslandPolicy,
} from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import { nodeIslandSet } from "../node-islands/boundary.js";
import type { IslandModule, IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import {
  classifyDiagnostic,
  classifyMarker,
  isIslandReasonCode,
} from "../node-islands/classify.js";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import { describe } from "../node-islands/summary.js";
import { resolveBareModule } from "../frontend/resolve.js";
import type { NodeIslandScan } from "../node-islands/scan.js";
import {
  foldFenceGrowth,
  growIslandSet,
  type IslandGrowthContext,
} from "../node-islands/growth.js";
import type { NodeIslandMarker } from "../node-islands/detect.js";
import {
  islandDecisionKey,
  readIslandDecision,
  writeIslandDecision,
  type IslandRoundState,
} from "../node-islands/decision-file.js";
import { isJsSourceFileName } from "../frontend/tsc-codes.js";

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

/** The parts of a frontend `decideNodeIslands` reads. Typing the decision's
 * argument as this capture makes the checker prove it reads nothing else. */
type IslandDecisionInputs = Pick<
  Frontend,
  "npmStatic" | "npmImportSites" | "preflight" | "nodeIslandScan"
>;

/** What the island rounds of one compile share. Every round's first
 * frontend is the same call — createFrontend(entryPath, opts.npmStatic,
 * undefined, undefined, { islandScan }) with the compile's own entry and
 * options — and a round after the first reads it only to decide its
 * islands. So the first round captures what that decision reads, and the
 * later rounds decide from the capture instead of loading and checking the
 * whole program again (on pi a 7-load npm-static ladder per round). */
interface RoundState {
  /** The first load's island-decision inputs, captured once per compile;
   * null until the first load has run (or when rounds may not reuse it,
   * see firstLoadReusable). */
  firstLoad: IslandDecisionInputs | null;
  /** False only through the internal round options (the island-round tests
   * compare a compile with and without reuse). */
  reuseFirstLoad: boolean;
  /** Whether a round that grew its island set also decides the fence-report
   * growth from the same pass (foldFenceGrowth, node-islands/growth.ts). Off
   * only through the internal round options, for the fold's own test. */
  foldFenceGrowth: boolean;
  /** The round this compile is in, for the round trace (1-based). */
  round: number;
}

/** SCRIPTC_ISLAND_ROUNDS_TRACE=1 at build time prints each island round's
 * starting set and the retry it decides: the evidence a build that folds its
 * growth rules (D4) islanded exactly what the two-round sequence did. */
function traceIslandRound(line: string): void {
  const t = process.env["SCRIPTC_ISLAND_ROUNDS_TRACE"];
  if (t === undefined || t === "" || t === "0") return;
  process.stderr.write(`[island-round] ${line}\n`);
}

function traceSet<K>(known: ReadonlyMap<string, K> | null): string {
  return known === null ? "null" : JSON.stringify([...known.keys()].sort());
}

/** Whether two lowering results are the same pass's: `fe.lower` may hand its
 * result back wrapped in a copy (the declaration-boundary notes), and the
 * retry it decided must still apply to it. */
function sameLowering(a: LowerResult, b: LowerResult): boolean {
  return a === b || (a.diagnostics === b.diagnostics && a.runtimeFences === b.runtimeFences);
}

/** Whether rounds may reuse the first load. Off with the shape overlay,
 * whose fallback state and memo (shape-inference/) a round's lowering
 * writes and the next load reads. */
function firstLoadReusable(state: RoundState): boolean {
  return state.reuseFirstLoad && !shapeOverlayEnabled();
}

/** A copy of `fe`'s island-decision inputs that outlives `fe`: the status
 * list, the import sites and the preflight copied, and each scan kept by
 * its arguments. `seal()` drops the copy's reference to `fe` once the
 * decision is made, so it never keeps a disposed program alive.
 * decideNodeIslands asks for the same scan in every round, so a sealed copy
 * asked for another one is a compiler bug. */
function captureIslandInputs(fe: Frontend): {
  inputs: IslandDecisionInputs;
  seal: () => void;
} {
  const scans = new Map<string, NodeIslandScan>();
  const source: { scan: Frontend["nodeIslandScan"] } = { scan: fe.nodeIslandScan };
  const inputs: IslandDecisionInputs = {
    npmStatic: [...fe.npmStatic],
    npmImportSites: new Map(fe.npmImportSites),
    preflight: [...fe.preflight],
    ...(fe.nodeIslandScan === undefined
      ? {}
      : {
          nodeIslandScan: (scanOpts: { userJs: boolean }): NodeIslandScan => {
            const key = String(scanOpts.userJs);
            const known = scans.get(key);
            if (known !== undefined) return known;
            const scan = source.scan;
            if (scan === undefined)
              throw new Error(
                `island round inputs: no scan for {userJs:${key}} after the load was released`,
              );
            const scanned = scan(scanOpts);
            scans.set(key, scanned);
            return scanned;
          },
        }),
  };
  return {
    inputs,
    seal: () => {
      source.scan = undefined;
    },
  };
}

/** The islands and modules a failing round's diagnostics grow, plus the
 * fence retry its result implies: the three retry decisions a round makes
 * from one lowering result (D-R, "only decide once"). */
interface RoundRetry {
  result: LowerResult;
  islands: Map<string, IslandPackage> | null;
  modules: Map<string, IslandModule> | null;
  fences: Map<string, IslandPackage> | null;
  /** Whether the next round may still run a fence rule. Off when this
   * retry already carries the fence-report growth: the round after it is
   * the last one, as it is after a report retry today. */
  nextRetryFences: boolean;
  /** See RoundRequest.fenceFallback. */
  fenceFallback: ReadonlyMap<string, IslandPackage> | null;
}

/** Internal round options, a test seam: the island-round tests turn the
 * first-load reuse off to compare a compile with and without it, and the
 * fence-growth fold off to compare the merged round with the two-round
 * sequence it replaces. */
export interface PrepareRoundOptions {
  reuseFirstLoad?: boolean;
  foldFenceGrowth?: boolean;
}

/** What every island round of one compile shares. */
interface PrepareInputs {
  entryPath: string;
  opts: CompileRequestOptions;
  ffi: FfiProfile | null;
  buildPlatform: string;
  createFrontend: FrontendFactory;
  timing: CompilationTiming;
  /** Whether the island decision reads the detector's scan. */
  islandScan: boolean;
}

/** The islands, modules and fence rule the next round retries with. */
interface RoundRequest {
  islands: ReadonlyMap<string, IslandPackage>;
  modules: ReadonlyMap<string, IslandModule>;
  retryFences: boolean;
  unitStore: UnitStore | null;
  /** When the round folded a sure-fence growth into the lowering's set: the
   * islands the lowering rule grew on its own. A build with the folded set
   * that fails retries from these with the fence rule on, so the fence retry
   * runs as it does without the fold and a failed sure-fence build keeps the
   * compiling build with an SC8023 warning. */
  fenceFallback: ReadonlyMap<string, IslandPackage> | null;
}

/** A compiling build that asked for a fence retry: the packages the fence
 * report grew, the attempts to try in order (the grown set, then the sure
 * subset) and what an attempt inherits from the build that asked. */
interface FenceRetry {
  /** The build returned when every attempt fails. */
  prepared: PreparedExecutableModule;
  attempts: Map<string, IslandPackage>[];
  grown: Map<string, IslandPackage>;
  /** The asking build's islands: the warning names what they do not have. */
  islands: ReadonlyMap<string, IslandPackage>;
  modules: ReadonlyMap<string, IslandModule>;
  unitStore: UnitStore | null;
}

/** One island round's result: a finished build (with the fence retry it
 * asked for, if any), a failure, or the set to retry with. A round returns
 * instead of recursing, so its frontend, lowering result and growth inputs
 * are unreachable before the next round loads. */
type RoundOutcome =
  | { kind: "prepared"; prepared: PreparedExecutableModule; fence: FenceRetry | null }
  | { kind: "failed"; failure: CompileFailure }
  | { kind: "retry"; request: RoundRequest };

/** `prepareExecutableModule` for a build: with `--node-island-decision` the
 * first island round starts from the islands the file records, and the
 * islands the build's last round started from are written back for the next
 * build (node-islands/decision-file.ts). The replayed round runs with the
 * fence rules on, as a first round does: they judge the program as it is
 * now, so a dependency added since the record is not left to a rule that
 * ran before it existed. A failed build records its decision too, so the
 * next one reports the same failure from one round. Without the option this
 * is `prepareExecutableModule` from scratch. */
export function prepareExecutableBuild(
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: CompilationTiming,
  unitStore: UnitStore | null,
): PreparedExecutableModule | CompileFailure {
  const file = opts.nodeIslands?.decision;
  if (file === undefined)
    return prepareExecutableModule(
      entryPath,
      opts,
      ffi,
      buildPlatform,
      createFrontend,
      timing,
      new Map(),
      true,
      unitStore,
    );
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  const key = islandDecisionKey(opts.nodeIslands, opts.npmStatic, buildPlatform);
  const replayed = readIslandDecision(file, entryPath, key, policy);
  if (replayed !== null)
    timing("island-decision-replay", {
      packages: replayed.packages.size,
      modules: replayed.modules.size,
    });
  const last: { state: IslandRoundState | null } = { state: null };
  const prepared = prepareExecutableModule(
    entryPath,
    opts,
    ffi,
    buildPlatform,
    createFrontend,
    timing,
    replayed === null ? new Map() : replayed.packages,
    true,
    unitStore,
    replayed === null ? new Map() : replayed.modules,
    {},
    (state) => {
      last.state = state;
    },
  );
  if (last.state !== null) writeIslandDecision(file, entryPath, key, policy, last.state);
  return prepared;
}

/** Release the parser/checker before native object generation begins.
 * `unitStore` keeps the lowered units of this build for the next one
 * (unit-reuse.ts).
 *
 * `lowerIslands` and `lowerModules` are the islands an island round starts
 * from: empty for a build that decides from scratch, the grown set for a
 * retry, and a recorded decision for a build that replays one
 * (node-islands/decision-file.ts). `onDecided` receives the islands of the
 * round whose result this call returns, which is what such a recording
 * keeps. */
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
  lowerModules: ReadonlyMap<string, IslandModule> = new Map(),
  roundOptions: PrepareRoundOptions = {},
  onDecided: ((state: IslandRoundState) => void) | null = null,
): PreparedExecutableModule | CompileFailure {
  // The islands of the round whose result this call returns: the request
  // that round ran, or, for a build that keeps its own result after its
  // fence attempts failed, the islands that build started from.
  const decided = (
    packages: ReadonlyMap<string, IslandPackage>,
    modules: ReadonlyMap<string, IslandModule>,
  ): void => {
    if (onDecided !== null) onDecided({ packages, modules });
  };
  const state: RoundState = {
    firstLoad: null,
    reuseFirstLoad: roundOptions.reuseFirstLoad !== false,
    foldFenceGrowth: roundOptions.foldFenceGrowth !== false,
    round: 1,
  };
  const inputs: PrepareInputs = {
    entryPath,
    opts,
    ffi,
    buildPlatform,
    createFrontend,
    timing,
    // The island decision reads the detector's scan unless islands are off.
    islandScan: nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands).mode !== "off",
  };
  // The island rounds run one at a time. A round whose preflight, lowering
  // or fence report grows the island set returns that set instead of
  // recursing, so its frontend, lowering result and growth inputs are all
  // unreachable before the next round loads (on pi the frontend's RSS grew
  // 5.3 -> 10 GB across three rounds while the rounds were recursive).
  let request: RoundRequest = {
    islands: lowerIslands,
    modules: lowerModules,
    retryFences,
    unitStore,
    fenceFallback: null,
  };
  // The fence retry a compiling build asked for: its attempts run in order
  // and the first that compiles replaces the build that asked for them. An
  // attempt that retries starts its own round chain; its failure ends the
  // attempt and the next one runs.
  let fence: { retry: FenceRetry; next: number; firstError: ScrDiagnostic | null } | null = null;
  for (;;) {
    const outcome = prepareRound(state, inputs, request);
    if (outcome.kind === "retry") {
      request = outcome.request;
      continue;
    }
    if (outcome.kind === "failed") {
      // A build with a folded sure-fence set that fails falls back to the
      // round the fold skipped: the lowering's islands alone, with the fence
      // rule on. That build compiles, its sure-fence retry fails too, and the
      // result is the compiling build with the SC8023 warning the two-round
      // sequence produces.
      if (request.fenceFallback !== null) {
        request = {
          islands: request.fenceFallback,
          modules: request.modules,
          retryFences: true,
          unitStore: request.unitStore,
          fenceFallback: null,
        };
        continue;
      }
      // Only a fence retry consumes a failure; otherwise it is the build's.
      const retry = fence;
      if (retry === null) {
        decided(request.islands, request.modules);
        return outcome.failure;
      }
      retry.firstError ??= outcome.failure.diagnostics[0] ?? null;
      const islands = retry.retry.attempts[retry.next++];
      if (islands !== undefined) {
        request = attemptRequest(retry.retry, islands);
        continue;
      }
      // Every attempt failed: the build that asked keeps its result and
      // carries an SC8023 warning with the first error.
      if (retry.firstError !== null) {
        const added = [...retry.retry.grown.keys()].filter(
          (name) => !retry.retry.islands.has(name),
        );
        retry.retry.prepared.warnings.push(
          nodeIslandRetryFailedDiag(added, retry.firstError, { file: entryPath, start: 0, end: 0 }),
        );
      }
      decided(retry.retry.islands, retry.retry.modules);
      return retry.retry.prepared;
    }
    // An attempt that compiles replaces the build that asked for it; the
    // outermost build is the result.
    if (fence !== null || outcome.fence === null) {
      decided(request.islands, request.modules);
      return outcome.prepared;
    }
    fence = { retry: outcome.fence, next: 1, firstError: null };
    request = attemptRequest(outcome.fence, outcome.fence.attempts[0]!);
  }
}

/** A fence attempt builds the same program with the packages as islands and
 * no fence retry of its own. */
function attemptRequest(
  retry: FenceRetry,
  islands: ReadonlyMap<string, IslandPackage>,
): RoundRequest {
  return {
    islands,
    modules: retry.modules,
    retryFences: false,
    unitStore: retry.unitStore,
    fenceFallback: null,
  };
}

function prepareRound(
  state: RoundState,
  inputs: PrepareInputs,
  request: RoundRequest,
): RoundOutcome {
  const { entryPath, opts, createFrontend, timing, islandScan, buildPlatform, ffi } = inputs;
  const { islands: lowerIslands, modules: lowerModules, retryFences, unitStore } = request;
  const round = state.round++;
  traceIslandRound(
    `round ${round} start islands=${traceSet(lowerIslands)} modules=${traceSet(lowerModules)} retryFences=${retryFences}`,
  );
  // A round after the first decides from the first round's capture of the
  // no-island load (RoundState). A decision that needs the frontend itself
  // loads it as before: none (this round lowers the no-island program) or
  // errors (whose failure reports its source texts).
  let first: Frontend | null = null;
  let islandDecision: ReturnType<typeof decideNodeIslands> =
    state.firstLoad === null
      ? null
      : decideNodeIslands(entryPath, opts, state.firstLoad, lowerIslands, lowerModules);
  if (state.firstLoad === null || islandDecision === null || islandDecision.errors.length > 0) {
    first = createFrontend(entryPath, opts.npmStatic, undefined, undefined, { islandScan });
    timing("frontend-load");
    const captured = captureIslandInputs(first);
    // Node islands (scope-B NI-4): packages refused natively run in Node,
    // unless the policy says otherwise. The frontend reloads without them,
    // so their declarations type the program.
    islandDecision = decideNodeIslands(
      entryPath,
      opts,
      captured.inputs,
      lowerIslands,
      lowerModules,
    );
    captured.seal();
    if (state.firstLoad === null && firstLoadReusable(state)) state.firstLoad = captured.inputs;
  }
  // A patched builtin the native build cannot represent (an entry module
  // patch, or a native read of a patched member) fails here.
  if (islandDecision !== null && islandDecision.errors.length > 0) {
    // Errors always come from a fresh load (above), so `first` is set.
    const diagnostics = islandDecision.errors;
    const sourceTexts = first!.sourceTexts();
    first!.dispose();
    return { kind: "failed", failure: { ok: false, diagnostics, sourceTexts } };
  }
  let fe: Frontend;
  if (islandDecision !== null) {
    first?.dispose();
    fe = createFrontend(entryPath, opts.npmStatic, undefined, undefined, {
      islandPackages: new Set(islandDecision.packages.keys()),
      ...(islandDecision.modules.size > 0
        ? { islandModules: new Set(islandDecision.modules.keys()) }
        : {}),
      islandScan,
    });
    timing("frontend-island-reload");
  } else {
    // A null decision always comes from a fresh load (above).
    fe = first!;
  }
  let lowered: LowerResult;
  let sourceTexts: Map<string, string>;
  let contractWarnings: ScrDiagnostic[] = [];
  let disposed = false;
  let fenceGrown: Map<string, IslandPackage> | null = null;
  const fenceSure = new Set<string>();
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
  // A round that retries with more islands decides from one lowering result
  // alone (D-R, "only decide once"): the whole-slot and stream relowers
  // exist to pick the pass a failure is reported from, and a retry throws
  // them away. The passes below ask `decideRetry` through
  // LowerOptions.stopAfterPushDown and stop when it implies any retry; the
  // failure path then retries with exactly these sets. One helper computes
  // the decisions for both, so they cannot drift.
  const pushDown: { retry: RoundRetry | null } = { retry: null };
  const decideRetry = (result: LowerResult): RoundRetry => {
    const growth = growthOf();
    const modules = loweringModules(entryPath, opts, result.diagnostics, lowerModules);
    let islands =
      growth === null
        ? null
        : growIslandSet(growth, lowerIslands, { diagnostics: result.diagnostics });
    let fences =
      retryFences && growth !== null
        ? growIslandSet(growth, lowerIslands, {
            diagnostics: result.diagnostics,
            fences: result.runtimeFences,
            fenceMode: "report",
          })
        : null;
    let nextRetryFences = retryFences;
    let fenceFallback: Map<string, IslandPackage> | null = null;
    if (state.foldFenceGrowth && growth !== null && islands !== null && fences !== null) {
      // Both rules grew the set. The fence-report rule is consulted after the
      // lowering rule finds nothing, so today's build reloads twice: once for
      // the refusals, once for the fences the reloaded program still holds.
      // Fold the second decision into this one (node-islands/growth.ts): the
      // fence rule reads only what the reload still compiles, and the round
      // that would make it is the one this retry becomes.
      const folded = foldFenceGrowth(growth, islands, modules ?? lowerModules, {
        diagnostics: result.diagnostics,
        fences: result.runtimeFences,
      });
      if (folded !== null) {
        // A folded sure-fence set is the growth a compiling build asks for;
        // the build carrying it can fail where that compiling build does
        // not, so the retry keeps the lowering's set to fall back to.
        if (folded.sure) fenceFallback = islands;
        islands = folded.islands;
        fences = null;
        nextRetryFences = false;
      }
      // A fold that grows nothing leaves the retry the rules would have made
      // on their own: the reload compiles, or the fence rule is decided from
      // that reload's own result.
    }
    traceIslandRound(
      `round ${round} decide islands=${traceSet(islands)} modules=${traceSet(modules)} fences=${traceSet(fences)} nextRetryFences=${nextRetryFences}`,
    );
    return { result, islands, modules, fences, nextRetryFences, fenceFallback };
  };
  // The frontend (and its tsgo server) is released as soon as lowering
  // ends — clang and the link never hold it open.
  try {
    const fail = (diagnostics: ScrDiagnostic[]): RoundOutcome => ({
      kind: "failed",
      failure: {
        ok: false,
        diagnostics,
        sourceTexts: fe.sourceTexts(),
      },
    });

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
      if (late !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return {
          kind: "retry",
          request: {
            islands: late,
            modules: lowerModules,
            retryFences,
            unitStore,
            fenceFallback: null,
          },
        };
      }
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
      if (grown !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return {
          kind: "retry",
          request: {
            islands: grown,
            modules: lowerModules,
            retryFences,
            unitStore,
            fenceFallback: null,
          },
        };
      }
      return fail(fe.preflight);
    }

    try {
      lowered = fe.lower(
        {
          ...(islandDecision !== null ? { nodeIslands: islandDecision } : {}),
          // The lowering stops as soon as one pass's failure implies a retry
          // (decideRetry above). A round that would not retry runs the full
          // pipeline, so a failing build still reports from the pass that
          // wins.
          stopAfterPushDown: (result: LowerResult) => {
            pushDown.retry = decideRetry(result);
            return (
              pushDown.retry.islands !== null ||
              pushDown.retry.modules !== null ||
              pushDown.retry.fences !== null
            );
          },
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
      // The decisions `fe.lower` already made from this exact result, when
      // it stopped after the push-down (or push-down-mode stream) pass;
      // otherwise from the pass that won.
      // The decision `fe.lower` already made from this exact result, when it
      // stopped after the push-down (or push-down-mode stream) pass;
      // otherwise the same helper on the winning pass's own result. `fe.lower`
      // may return the result it decided from wrapped in a copy (the
      // declaration-boundary notes), so the decision is matched on the
      // result's arrays, not on object identity.
      const decided =
        pushDown.retry !== null && sameLowering(pushDown.retry.result, lowered)
          ? pushDown.retry
          : decideRetry(lowered);
      // Packages whose own modules refused to lower run in Node islands
      // too (the authoritative lowering, DESIGN.md §1.4): build again with
      // them as islands. Sloppy user modules the lowering refused join the
      // same retry (DESIGN.md note 1 §3.2): one reload with every island at
      // once, never one round per module.
      const grown = decided.islands;
      const grownModules = decided.modules;
      if (grown !== null || grownModules !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return {
          kind: "retry",
          request: {
            islands: grown ?? lowerIslands,
            modules: grownModules ?? lowerModules,
            retryFences: decided.nextRetryFences,
            unitStore,
            fenceFallback: decided.fenceFallback,
          },
        };
      }
      // A failed program whose compiled packages need the runtime or a
      // mutable object model (NI-2's report): try them as islands. If that
      // build fails too, its failure is the one reported. This build typed
      // those packages from their JavaScript, where the types they only
      // declare (interfaces, aliases such as `Static<T>`) are `any`, so its
      // diagnostics describe a program the island build does not compile:
      // there the packages' declarations type the user code.
      const marked = decided.fences;
      if (marked !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return {
          kind: "retry",
          request: {
            islands: marked,
            modules: lowerModules,
            retryFences: false,
            unitStore: null,
            fenceFallback: null,
          },
        };
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
      contractWarnings = checked.warnings;
    }
    if (retryFences) {
      const growth = growthOf();
      fenceGrown =
        growth === null
          ? null
          : growIslandSet(growth, lowerIslands, {
              diagnostics: lowered.diagnostics,
              fences: lowered.runtimeFences,
              fenceMode: "sure",
              sure: fenceSure,
            });
    }
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
  // Packages compiled with runtime fences that need the JavaScript
  // runtime or a mutable object model (fenceIslands): build again with
  // them as islands, and keep this build when that one cannot compile.
  // If that build fails, retry with only the packages whose fences fire
  // for sure (module-init or runtime fences); if that fails too, the native
  // build carries an SC8023 warning with the island build's first error,
  // never a silent fallback. The attempts run in the round driver, after
  // this round's state is released (see prepareExecutableModule).
  if (fenceGrown === null) return { kind: "prepared", prepared, fence: null };
  const attempts = [fenceGrown];
  const sure = new Map(
    [...fenceGrown].filter(([name]) => lowerIslands.has(name) || fenceSure.has(name)),
  );
  if (sure.size > lowerIslands.size && sure.size < fenceGrown.size) attempts.push(sure);
  return {
    kind: "prepared",
    prepared,
    fence: {
      prepared,
      attempts,
      grown: fenceGrown,
      islands: lowerIslands,
      modules: lowerModules,
      unitStore,
    },
  };
}

/** Whether two spellings name the same file (the checker resolves through
 * symlinks; a CLI argument may not). */
function sameFile(a: string, b: string): boolean {
  if (samePath(a, b)) return true;
  try {
    const real = realpathSync(a);
    const other = realpathSync(b);
    return samePath(real, other);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll("\\", "/") === b.replaceAll("\\", "/");
}

/** The pre-scan reasons that make a user module a sloppy-semantics island
 * by themselves (DESIGN.md note 1 §3.1): the constructs whose behavior
 * needs the JavaScript engine and that a syntax scan decides exactly, plus
 * the conservative `this` marker (decision S2). */
const SLOPPY_REASONS: ReadonlySet<string> = new Set([
  "with",
  "direct-eval",
  "annexb-block-function",
  "sloppy-this",
]);

/** A module that patches a builtin module's CommonJS object (the user's
 * decision, 2026-10-29): its patch is meant for code that shares Node's
 * builtin, so it runs in Node, where an island consumer sees it. */
const PATCH_REASONS: ReadonlySet<string> = new Set(["builtin-patch"]);

/** The program modules that run in Node islands, by file: modules marked
 * with `--node-island=<path>` or `scriptc.nodeIslands.modules`, and (under
 * `--node-islands=auto`) user JavaScript the pre-scan found a sloppy-only
 * construct in (decision S3). The entry stays native: a program whose entry
 * is an island runs the whole file in Node, which is a different feature. */
interface ModuleIslandDecision {
  modules: Map<string, IslandModule>;
  /** The entry module's own `builtin-patch` marker: the entry stays native
   * (a whole-file island is a different feature), so the build refuses it
   * with SC8006. */
  entryPatch: { file: string; marker: NodeIslandMarker } | null;
  /** User TypeScript modules with a `builtin-patch` marker that Node
   * cannot run with type stripping only (H3.5): SC8006, kept native. */
  stripProblems: { file: string; construct: string; loc: SrcLoc }[];
}

function moduleIslands(
  entryPath: string,
  policy: NodeIslandPolicy,
  scan: NodeIslandScan,
): ModuleIslandDecision {
  const modules = new Map<string, IslandModule>();
  let entryPatch: ModuleIslandDecision["entryPatch"] = null;
  const stripProblems: ModuleIslandDecision["stripProblems"] = [];
  for (const m of scan.modules) {
    if (m.origin !== "user") continue;
    const patches = m.markers.filter((marker) => PATCH_REASONS.has(marker.reason));
    // A TypeScript module islands only for a builtin patch (H3.2).
    if (!isJsSourceFileName(m.file) && patches.length === 0) continue;
    if (sameFile(m.file, entryPath)) {
      if (patches.length > 0 && entryPatch === null)
        entryPatch = { file: m.file, marker: patches[0]! };
      continue;
    }
    if (m.stripProblem !== null) {
      stripProblems.push({ file: m.file, ...m.stripProblem });
      continue;
    }
    const marked = isMarkedUserModule(policy, m.file);
    const sloppy = m.markers.filter((marker) => SLOPPY_REASONS.has(marker.reason));
    if (
      marked === null &&
      (policy.mode !== "auto" || (sloppy.length === 0 && patches.length === 0))
    )
      continue;
    const first = sloppy[0] ?? patches[0];
    const reason = first === undefined ? null : classifyMarker(first);
    modules.set(m.file, {
      file: m.file,
      class: reason === null ? "marked" : reason.class,
      reason:
        reason === null
          ? marked === "cli"
            ? "marked with --node-island"
            : 'marked "node" in scriptc.nodeIslands.modules'
          : describe(reason),
      decision: marked === null ? "auto" : "marked",
    });
  }
  return { modules, entryPatch, stripProblems };
}

/** The packages and modules a build runs in Node islands, or null for none:
 * under `--node-islands=auto` (the default) every npm package the native
 * pipeline refused plus the user modules the pre-scan found a sloppy
 * construct in, and packages marked `node`; under `explicit` only the
 * marked ones; under `off`, none (refusals stay SC2013). Each island is
 * reported once as an SC8001 note. */
function decideNodeIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: IslandDecisionInputs,
  lowerIslands: ReadonlyMap<string, IslandPackage>,
  lowerModules: ReadonlyMap<string, IslandModule>,
): (NodeIslandSet & { notes: ScrDiagnostic[]; errors: ScrDiagnostic[] }) | null {
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
  // The pre-scan's user-JavaScript markers exist only where a build may act
  // on them.
  const scan = fe.nodeIslandScan({ userJs: policy.mode === "auto" });
  const moduleDecision = moduleIslands(entryPath, policy, scan);
  const modules = moduleDecision.modules;
  // A sloppy write to an undeclared name creates a global — a sloppy-only
  // semantic the native tier does not implement, so the module runs in
  // Node (the user's policy, 2026-10-31). The checker decides this one, not
  // the syntax pre-scan: a write target needs bindings, and its sloppiness
  // depends on the enclosing function and file strictness. Preflight
  // reports it as SC1091 carrying the R2.4 reason. The entry stays native
  // (a whole-file island is a different feature), and a strict-mode write
  // is an ordinary lowering gap, so neither joins here.
  if (policy.mode === "auto") {
    for (const d of fe.preflight) {
      if (d.code !== "SC1091" || d.reason !== "implicit-global-write") continue;
      const file = d.loc.file;
      if (modules.has(file) || sameFile(file, entryPath)) continue;
      if (!isJsSourceFileName(file) || file.includes("/node_modules/")) continue;
      const reason = classifyDiagnostic(d, "refusal");
      modules.set(file, {
        file,
        class: reason.class,
        reason: describe(reason),
        decision: "auto",
      });
    }
  }
  // Modules the lowering refused keep their first reason (the reload no
  // longer compiles them).
  for (const [file, island] of lowerModules) if (!modules.has(file)) modules.set(file, island);
  const errors: ScrDiagnostic[] = [];
  if (moduleDecision.entryPatch !== null) {
    const { file, marker } = moduleDecision.entryPatch;
    errors.push(
      nodeIslandEntryPatchDiag(
        file,
        marker.member ?? marker.construct,
        builtinModuleOf(marker.member),
        marker.loc,
      ),
    );
  }
  for (const problem of moduleDecision.stripProblems)
    errors.push(nodeIslandStripDiag(problem.file, problem.construct, problem.loc));
  // Who else must see the patch (H3.4): every module that reads a patched
  // member through the builtin's CommonJS object joins the island set, npm
  // package or user module alike — the patch lives in the islands' Node, and
  // only sharing the builtin shows the read the patch, as in Node. The entry
  // stays native, and a user TypeScript module Node cannot strip cannot run
  // in Node at all: both are SC8006.
  const patchedMembers = new Map<string, string>();
  for (const m of scan.modules) {
    if (!modules.has(m.file)) continue;
    for (const marker of m.markers) {
      if (!PATCH_REASONS.has(marker.reason) || marker.member === undefined) continue;
      if (!patchedMembers.has(marker.member)) patchedMembers.set(marker.member, m.file);
    }
  }
  const readerPackages = new Map<
    string,
    { packageDir: string; member: string; patchFile: string }
  >();
  // A package the build marks native stays native: a read that only an
  // island could satisfy is SC8003, once per package and construct.
  const forcedNativeReads = new Set<string>();
  const readerModules = new Map<string, { member: string; patchFile: string }>();
  if (policy.mode === "auto" && patchedMembers.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.cjsReads) {
        const patchFile = patchFileOf(patchedMembers, read.member);
        if (patchFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (policy.forcedNative.has(m.packageName)) {
            const key = `${m.packageName}:${read.member}`;
            if (!forcedNativeReads.has(key)) {
              forcedNativeReads.add(key);
              errors.push(
                nativePackageDiag(
                  m.packageName,
                  `it reads '${read.member}' through the CommonJS ${builtinModuleOf(read.member)} object, which island module ${patchFile} patches; a native read cannot see the patch`,
                  fe.npmImportSites.get(m.packageName) ?? read.loc,
                ),
              );
            }
            continue;
          }
          if (!readerPackages.has(m.packageName) && !refused.has(m.packageName))
            readerPackages.set(m.packageName, {
              packageDir: m.packageDir,
              member: read.member,
              patchFile,
            });
        } else if (m.origin === "user") {
          if (sameFile(m.file, entryPath)) {
            errors.push(
              nodeIslandEntryReadDiag(
                m.file,
                read.member,
                builtinModuleOf(read.member),
                patchFile,
                read.loc,
              ),
            );
            continue;
          }
          if (m.stripProblem !== null) {
            errors.push(
              nodeIslandReaderStripDiag(
                m.file,
                read.member,
                patchFile,
                m.stripProblem.construct,
                m.stripProblem.loc,
              ),
            );
            continue;
          }
          if (!readerModules.has(m.file))
            readerModules.set(m.file, { member: read.member, patchFile });
        }
      }
    }
  }
  // Who else must see an implicit global (H3.4): a sloppy write creates the
  // name on Node's global object when its island module runs, and native
  // code has no global object to read it from. An npm package that reads
  // the name joins the island set (its Node sees the global); a user module
  // or the entry is SC8020.
  const readerGlobals = new Map<
    string,
    { packageDir: string; global: string; writerFile: string }
  >();
  const createdGlobals =
    policy.mode === "auto" ? implicitGlobalWrites(fe, modules) : new Map<string, string>();
  if (createdGlobals.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.globalReads) {
        const writerFile = createdGlobals.get(read.name);
        if (writerFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (policy.forcedNative.has(m.packageName)) {
            const key = `${m.packageName}:${read.name}`;
            if (!forcedNativeReads.has(key)) {
              forcedNativeReads.add(key);
              errors.push(
                nativePackageDiag(
                  m.packageName,
                  `it reads '${read.name}', which island module ${writerFile} creates as an implicit global; the native build has no global object, so the read cannot see it`,
                  fe.npmImportSites.get(m.packageName) ?? read.loc,
                ),
              );
            }
            continue;
          }
          if (!readerGlobals.has(m.packageName) && !refused.has(m.packageName))
            readerGlobals.set(m.packageName, {
              packageDir: m.packageDir,
              global: read.name,
              writerFile,
            });
        } else if (m.origin === "user") {
          errors.push(nodeIslandImplicitGlobalReadDiag(read.name, writerFile, read.loc));
        }
      }
    }
  }
  if (errors.length > 0) return { ...nodeIslandSet(new Map(), new Map()), notes: [], errors };
  // A user module that reads a patched member runs in a Node island, so its
  // read goes through the patched object exactly as in Node (H3.4).
  for (const [file, reader] of readerModules) {
    modules.set(file, {
      file,
      class: "object-model",
      reason: `it reads '${reader.member}' through the CommonJS ${builtinModuleOf(reader.member)} object, which island module ${reader.patchFile} patches`,
      decision: "auto",
    });
  }
  if (
    refused.size === 0 &&
    policy.forcedNode.size === 0 &&
    modules.size === 0 &&
    readerPackages.size === 0 &&
    readerGlobals.size === 0
  )
    return null;
  const report = buildNodeIslandReport({
    entry: entryPath,
    scan,
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
    const dir = installedDirOf(site.file, name);
    if (dir === null) continue;
    const status = fe.npmStatic.find((e) => e.package === name);
    packages.set(name, {
      name,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason: status?.detail ?? "its static compilation was refused",
    });
    notes.push(
      nodeIslandNoteDiag(name, packageVersionOf(dir), "packaging", status?.detail ?? "", site),
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
  // npm packages that read a patched member join the island set: their
  // patch lives in the island's Node, and only a shared builtin shows it.
  for (const [name, reader] of readerPackages) {
    if (packages.has(name)) continue;
    const version = packageVersionOf(reader.packageDir);
    const reason = `it reads '${reader.member}' through the CommonJS ${builtinModuleOf(reader.member)} object, which island module ${reader.patchFile} patches`;
    packages.set(name, {
      name,
      version,
      dir: reader.packageDir,
      class: "object-model",
      reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        name,
        version,
        "object-model",
        reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  // npm packages that read an implicit global an island module creates join
  // the island set: the global lives on their Node's global object.
  for (const [name, reader] of readerGlobals) {
    if (packages.has(name)) continue;
    const version = packageVersionOf(reader.packageDir);
    const reason = `it reads '${reader.global}', the implicit global island module ${reader.writerFile} creates`;
    packages.set(name, {
      name,
      version,
      dir: reader.packageDir,
      class: "object-model",
      reason,
    });
    notes.push(
      nodeIslandNoteDiag(
        name,
        version,
        "object-model",
        reason,
        fe.npmImportSites.get(name) ?? { file: entryPath, start: 0, end: 0 },
      ),
    );
  }
  for (const island of [...modules.values()].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  ))
    notes.push(
      nodeIslandModuleNoteDiag(island.file, island.class, island.reason, {
        file: island.file,
        start: 0,
        end: 0,
      }),
    );
  return packages.size === 0 && modules.size === 0
    ? null
    : { ...nodeIslandSet(packages, modules), notes, errors };
}

/** The installed package directory of `name` as Node resolves it from
 * `fromFile`, or null when there is none. `packageDirOf` reads the directory
 * off a file path, which answers only while that path names a node_modules
 * segment: a workspace-linked package's realpath elides the link, so its
 * directory is the resolution's own `workspaceDir` (the same answer the
 * checker's program registered the package under). */
function installedDirOf(fromFile: string, name: string): string | null {
  const js =
    resolveBareModule(fromFile, name, "js-only") ??
    resolveBareModule(fromFile, name, "js-only", "require");
  if (js === null) return null;
  return packageDirOf(js.typesFile)?.dir ?? js.workspaceDir ?? null;
}

/** Every package this pass binds to a Node island: the ones earlier rounds
 * decided (`lowerIslands`) plus this pass's decision. */
function islandedPackages(
  lowerIslands: ReadonlyMap<string, IslandPackage>,
  decision: NodeIslandSet | null,
): Map<string, IslandPackage> {
  const all = new Map(lowerIslands);
  if (decision !== null) for (const [name, island] of decision.packages) all.set(name, island);
  return all;
}

/** The island set grown by refused packages no island binds yet, or null
 * when there are none. `decideNodeIslands` places the refusals it can see in
 * the detector's report and resolve from their import sites; a package
 * refused before it joined the type-checked program can be missing from
 * both. Under `--node-islands=auto` such a refusal is not fatal while the
 * package can run in Node: grow the island set and analyse the program once
 * more. Growth is monotone — an islanded package is never compiled
 * statically again — and a project has finitely many packages, so the retry
 * reaches a fixed point instead of looping. An explicit `--node-islands`
 * list or `off` keeps refusals fatal. */
function refusalIslands(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
  refused: readonly NpmStaticStatus[],
  known: ReadonlyMap<string, IslandPackage>,
): Map<string, IslandPackage> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto") return null;
  const grown = new Map(known);
  for (const entry of refused) {
    if (grown.has(entry.package)) continue;
    if (policy.forcedNative.has(entry.package) || policy.unloaded.has(entry.package)) continue;
    const site = fe.npmImportSites.get(entry.package) ?? { file: entryPath, start: 0, end: 0 };
    const dir = installedDirOf(site.file, entry.package);
    // A refusal whose directory cannot be resolved has nothing to island;
    // the fatal diagnostic keeps it visible.
    if (dir === null) continue;
    grown.set(entry.package, {
      name: entry.package,
      version: packageVersionOf(dir),
      dir,
      class: "packaging",
      reason: entry.detail ?? "its static compilation was refused",
    });
  }
  return grown.size === known.size ? null : grown;
}

/** The names the island modules' sloppy implicit-global writes create, each
 * with the file that creates it. Preflight reports each write as an SC1091
 * whose range is the write target. */
function implicitGlobalWrites(
  fe: IslandDecisionInputs,
  modules: ReadonlyMap<string, IslandModule>,
): Map<string, string> {
  const globals = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const d of fe.preflight) {
    if (d.code !== "SC1091" || d.reason !== "implicit-global-write") continue;
    const file = d.loc.file;
    if (!modules.has(file)) continue;
    let source = sources.get(file);
    if (source === undefined) {
      source = readFileSync(file, "utf8");
      sources.set(file, source);
    }
    const name = source.slice(d.loc.start, d.loc.end);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !globals.has(name)) globals.set(name, file);
  }
  return globals;
}

/** The builtin module a patched member belongs to ("fs" of
 * "fs.readFileSync"). */
function builtinModuleOf(member: string | undefined): string {
  if (member === undefined) return "";
  const end = /[.[]/.exec(member);
  return end === null ? member : member.slice(0, end.index);
}

/** The island module that patches `member`, matching an exact member or a
 * whole-module patch ("fs.*"). A read the scan cannot name ("fs.*", a
 * computed key or a rest element) matches every patch of its module, and so
 * does a patch through a computed key ("fs[…]"). */
function patchFileOf(patched: ReadonlyMap<string, string>, member: string): string | undefined {
  const module = builtinModuleOf(member);
  const exact = patched.get(member) ?? patched.get(`${module}.*`);
  if (exact !== undefined) return exact;
  const unnamedRead = member === `${module}.*`;
  for (const [patch, file] of patched) {
    if (builtinModuleOf(patch) !== module) continue;
    if (unnamedRead || patch.includes("[")) return file;
  }
  return undefined;
}

/** The growth inputs this build's frontend offers the shared island-growth
 * rules (node-islands/growth.ts), or null when the frontend holds no island
 * scan: the rules then grow nothing. `npmStatic` keeps a `"auto"` request
 * out: only an explicit list names the packages to keep native. */
function islandGrowth(
  entryPath: string,
  opts: CompileRequestOptions,
  fe: ReturnType<FrontendFactory>,
): IslandGrowthContext | null {
  const scan = fe.nodeIslandScan?.({ userJs: false });
  if (scan === undefined) return null;
  return {
    entry: entryPath,
    policy: nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands),
    scan,
    npm: fe.npmStatic,
    npmImportSites: fe.npmImportSites,
    ...(Array.isArray(opts.npmStatic) ? { explicitNpmStatic: opts.npmStatic } : {}),
    sourceTexts: () => fe.sourceTexts(),
  };
}

/** The island modules grown by the lowering's refusals in user JavaScript
 * (`--node-islands=auto` only), or null when there are none: a sloppy
 * module whose semantics the native pipeline refuses (an implicit global,
 * a mapped `arguments`, a `with` the pre-scan could not decide) runs in
 * Node. One retry adds every one of them at once. */
function loweringModules(
  entryPath: string,
  opts: CompileRequestOptions,
  diagnostics: readonly ScrDiagnostic[],
  known: ReadonlyMap<string, IslandModule>,
): Map<string, IslandModule> | null {
  const policy = nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands);
  if (policy.mode !== "auto" || known.size > 16) return null;
  const grown = new Map(known);
  for (const d of diagnostics) {
    if (!isIslandReasonCode(d.code)) continue;
    const file = d.loc.file;
    // Packages run in Node through their own decision
    // (node-islands/growth.ts).
    if (file.includes("/node_modules/") || packageDirOf(file) !== null) continue;
    if (!isJsSourceFileName(file) || sameFile(file, entryPath)) continue;
    if (grown.has(file)) continue;
    const reason = classifyDiagnostic(d, "refusal");
    // A gap is a construct scriptc does not implement, not a sloppy
    // semantic: running it in Node would hide a compiler limitation.
    if (reason.class === "gap") continue;
    grown.set(file, {
      file,
      class: reason.class,
      reason: describe(reason),
      decision: "auto",
    });
  }
  return grown.size === known.size ? null : grown;
}
