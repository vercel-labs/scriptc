import { realpathSync } from "node:fs";
import type { CompileFailure, CompileRequestOptions } from "../compile-types.js";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { frontendDisposed } from "../frontend/dispose-hook.js";
import {
  checkerPanicDiag,
  nodeIslandEntryPatchDiag,
  nodeIslandModuleNoteDiag,
  nodeIslandNoteDiag,
  nodeIslandPatchedReadDiag,
  nodeIslandStripDiag,
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
import type { Frontend, FrontendFactory } from "../frontend/pipeline.js";
import { shapeOverlayEnabled } from "../frontend/shape-inference/index.js";
import type { UnitStore } from "../frontend/lowering/unit-reuse.js";
import type { CompilationTiming } from "../timing.js";
import { readProjectConfig } from "../project-config.js";
import {
  isMarkedUserModule,
  nodeIslandPolicy,
  type NodeIslandPolicy,
} from "../node-islands/policy.js";
import { buildNodeIslandReport } from "../node-islands/report.js";
import { growEsmImporters, outsideGraphIslands } from "../node-islands/graph-islands.js";
import type { IslandModule, IslandPackage, NodeIslandSet } from "../node-islands/boundary.js";
import {
  classifyDiagnostic,
  classifyMarker,
  isIslandReasonCode,
} from "../node-islands/classify.js";
import { packageDirOf, packageVersionOf } from "../node-islands/origin.js";
import { describe } from "../node-islands/summary.js";
import { resolveBareModule } from "../frontend/resolve.js";
import { isEsmFile } from "../frontend/lowering/lower-node-island.js";
import type { NodeIslandScan, PackageEdge } from "../node-islands/scan.js";
import type { NodeIslandMarker } from "../node-islands/detect.js";
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

/** The parts of a frontend `decideNodeIslands` reads. */
type IslandDecisionInputs = Pick<Frontend, "npmStatic" | "npmImportSites" | "nodeIslandScan">;

/** What the island rounds of one compile share. Every round's first
 * frontend is the same call — createFrontend(entryPath, opts.npmStatic,
 * undefined, undefined, { islandScan }) with the compile's own entry and
 * options — and a round after the first reads it only to decide its
 * islands. So the first round captures what that decision reads, and the
 * later rounds decide from the capture instead of loading and checking the
 * whole program again (on pi a 7-load npm-static ladder per round). */
interface RoundState {
  /** The first load's island-decision inputs, captured once per compile;
   * null while the first load has not run, or when rounds may not reuse
   * it (see firstLoadReusable). */
  firstLoad: IslandDecisionInputs | null;
  /** False only through the internal round options (the island-round
   * tests compare a compile with and without reuse). */
  reuseFirstLoad: boolean;
  /** False only through the internal round options (the island-round
   * tests compare a compile with and without the graph decision). */
  preDeriveIslands: boolean;
}

/** Whether rounds may reuse the first load. Off with the shape overlay,
 * whose fallback state and memo (shape-inference/) a round's lowering
 * writes and the next load reads. */
function firstLoadReusable(state: RoundState): boolean {
  return state.reuseFirstLoad && !shapeOverlayEnabled();
}

/** A copy of `fe`'s island-decision inputs that outlives `fe`: the status
 * list and the import sites copied, and each scan kept by its arguments.
 * `seal()` drops the reference to `fe` once the decision is made, so the
 * copy never keeps a disposed program alive. decideNodeIslands asks for the
 * same scan in every round, so a sealed copy asked for another one is a
 * compiler bug. */
function captureIslandInputs(fe: Frontend): { inputs: IslandDecisionInputs; seal: () => void } {
  const scans = new Map<string, NodeIslandScan>();
  const source: { scan: Frontend["nodeIslandScan"] } = { scan: fe.nodeIslandScan };
  const inputs: IslandDecisionInputs = {
    npmStatic: [...fe.npmStatic],
    npmImportSites: new Map(fe.npmImportSites),
    nodeIslandScan:
      fe.nodeIslandScan === undefined
        ? undefined
        : (scanOpts) => {
            const key = JSON.stringify([scanOpts.userJs]);
            const known = scans.get(key);
            if (known !== undefined) return known;
            const scan = source.scan;
            if (scan === undefined)
              throw new Error(
                `island round inputs: no scan for ${key} after the load was released`,
              );
            const scanned = scan(scanOpts);
            scans.set(key, scanned);
            return scanned;
          },
  };
  return {
    inputs,
    seal: () => {
      source.scan = undefined;
    },
  };
}

/** The islands and modules a failing round's diagnostics grow, plus the
 * fence retry its result implies: the three retry decisions prepareRound
 * makes from one lowering result (retry-round SPEC, D-R R2). */
interface RoundRetry {
  result: LowerResult;
  islands: Map<string, IslandPackage> | null;
  modules: Map<string, IslandModule> | null;
  fences: Map<string, IslandPackage> | null;
}

/** Internal round options, a test seam: the island-round tests turn the
 * first-load reuse off to compare a compile with and without it. */
export interface PrepareRoundOptions {
  reuseFirstLoad?: boolean;
  /** Off compiles the discovery round the retry path would before deciding
   * the islands the module graph proves, for tests that compare both. */
  preDeriveIslands?: boolean;
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
  lowerModules: ReadonlyMap<string, IslandModule> = new Map(),
  roundOptions: PrepareRoundOptions = {},
): PreparedExecutableModule | CompileFailure {
  return prepareRound(
    {
      firstLoad: null,
      reuseFirstLoad: roundOptions.reuseFirstLoad !== false,
      preDeriveIslands: roundOptions.preDeriveIslands !== false,
    },
    entryPath,
    opts,
    ffi,
    buildPlatform,
    createFrontend,
    timing,
    lowerIslands,
    retryFences,
    unitStore,
    lowerModules,
  );
}

function prepareRound(
  state: RoundState,
  entryPath: string,
  opts: CompileRequestOptions,
  ffi: FfiProfile | null,
  buildPlatform: string,
  createFrontend: FrontendFactory,
  timing: CompilationTiming,
  lowerIslands: ReadonlyMap<string, IslandPackage>,
  retryFences: boolean,
  unitStore: UnitStore | null,
  lowerModules: ReadonlyMap<string, IslandModule>,
): PreparedExecutableModule | CompileFailure {
  // The island decision reads the detector's scan unless islands are off.
  const islandScan =
    nodeIslandPolicy(readProjectConfig(entryPath), opts.nodeIslands).mode !== "off";
  // A round after the first decides from the first round's capture of the
  // no-island load (RoundState). A decision that needs the frontend itself
  // loads it as before: none (this round lowers the no-island program) or
  // errors (whose failure reports its source texts).
  let first: Frontend | null = null;
  let islandDecision: ReturnType<typeof decideNodeIslands> =
    state.firstLoad === null
      ? null
      : decideNodeIslands(
          entryPath,
          opts,
          state.firstLoad,
          lowerIslands,
          lowerModules,
          state.preDeriveIslands,
        );
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
      state.preDeriveIslands,
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
    return { ok: false, diagnostics, sourceTexts };
  }
  // The island set this round starts from: the packages an earlier round
  // grew, plus the ones the module graph proved before this lowering (they
  // are decided islands, so every later decision counts them as known).
  const islandBase =
    islandDecision?.graph == null
      ? lowerIslands
      : new Map([...lowerIslands, ...islandDecision.graph]);
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
  // A round that retries with more islands decides from its push-down pass
  // alone (retry-round SPEC, D-R R2): the whole-slot and stream relowers
  // exist to pick the pass the failure is reported from, and a retry throws
  // them away. `fe.lower` asks this predicate after that pass and stops
  // when it is true; the failure path below then retries with exactly these
  // sets instead of deciding from the same diagnostics again.
  const pushDown: { retry: RoundRetry | null } = { retry: null };
  const decideRetry = (result: LowerResult): RoundRetry => ({
    result,
    islands: loweringIslands(
      entryPath,
      opts,
      fe,
      result.diagnostics,
      islandBase,
      fe.nodeIslandScan?.({ userJs: false }).edges,
    ),
    modules: loweringModules(entryPath, opts, result.diagnostics, lowerModules),
    fences: retryFences ? fenceIslands(entryPath, opts, fe, result, islandBase, false) : null,
  });
  let lowered: LowerResult;
  let sourceTexts: Map<string, string>;
  let contractWarnings: ScrDiagnostic[] = [];
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
      const grown = preflightIslands(entryPath, opts, fe, islandBase);
      if (grown !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareRound(
          state,
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          grown,
          retryFences,
          unitStore,
          lowerModules,
        );
      }
      return fail(fe.preflight);
    }

    try {
      lowered = fe.lower(
        {
          ...(islandDecision !== null ? { nodeIslands: islandDecision } : {}),
          stopAfterPushDown: (result) => {
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
      // it stopped after the push-down pass (above); otherwise from the
      // pass that won.
      const retried =
        pushDown.retry !== null && pushDown.retry.result === lowered ? pushDown.retry : null;
      // Packages whose own modules refused to lower run in Node islands
      // too (the authoritative lowering, DESIGN.md §1.4): build again with
      // them as islands.
      const grown =
        retried !== null
          ? retried.islands
          : loweringIslands(
              entryPath,
              opts,
              fe,
              lowered.diagnostics,
              islandBase,
              fe.nodeIslandScan?.({ userJs: false }).edges,
            );
      // Sloppy user modules the lowering refused join the same retry
      // (DESIGN.md note 1 §3.2): one reload with every island at once,
      // never one round per module.
      const grownModules =
        retried !== null
          ? retried.modules
          : loweringModules(entryPath, opts, lowered.diagnostics, lowerModules);
      if (grown !== null || grownModules !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareRound(
          state,
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          grown ?? islandBase,
          retryFences,
          unitStore,
          grownModules ?? lowerModules,
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
        ? retried !== null
          ? retried.fences
          : fenceIslands(entryPath, opts, fe, lowered, islandBase, false)
        : null;
      if (marked !== null) {
        fe.dispose();
        frontendDisposed();
        disposed = true;
        return prepareRound(
          state,
          entryPath,
          opts,
          ffi,
          buildPlatform,
          createFrontend,
          timing,
          marked,
          false,
          null,
          lowerModules,
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
      contractWarnings = checked.warnings;
    }
    if (retryFences)
      fenceGrown = fenceIslands(entryPath, opts, fe, lowered, islandBase, true, fenceSure);
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
  // never a silent fallback.
  if (fenceGrown !== null) {
    const attempts = [fenceGrown];
    const sure = new Map(
      [...fenceGrown].filter(([name]) => islandBase.has(name) || fenceSure.has(name)),
    );
    if (sure.size > islandBase.size && sure.size < fenceGrown.size) attempts.push(sure);
    let firstError: ScrDiagnostic | null = null;
    for (const islands of attempts) {
      const islanded = prepareRound(
        state,
        entryPath,
        opts,
        ffi,
        buildPlatform,
        createFrontend,
        timing,
        islands,
        false,
        unitStore,
        lowerModules,
      );
      if (islanded.ok) return islanded;
      firstError ??= islanded.diagnostics[0] ?? null;
    }
    if (firstError !== null) {
      const added = [...fenceGrown.keys()].filter((name) => !islandBase.has(name));
      prepared.warnings.push(
        nodeIslandRetryFailedDiag(added, firstError, { file: entryPath, start: 0, end: 0 }),
      );
    }
  }
  return prepared;
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
  preDeriveIslands = true,
):
  | (NodeIslandSet & {
      notes: ScrDiagnostic[];
      errors: ScrDiagnostic[];
      /** The packages the module graph proved island (outsideGraphIslands); a
       * later round carries them like a set the lowering grew. */
      graph: Map<string, IslandPackage> | null;
    })
  | null {
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
  // The pre-scan's user-JavaScript markers exist only where a build may act
  // on them.
  const scan = fe.nodeIslandScan({ userJs: policy.mode === "auto" });
  const moduleDecision = moduleIslands(entryPath, policy, scan);
  const modules = moduleDecision.modules;
  // The island packages this decision adds are the ones the lowering's
  // refusals grew in an earlier round (a retry) plus the ones the module
  // graph already proves before the first lowering runs: deciding the
  // latter up front makes the first lowering the retry lowering.
  let known = lowerIslands;
  const pre = preDeriveIslands
    ? outsideGraphIslands(policy, fe.npmStatic, scan, modules, lowerIslands)
    : null;
  if (pre !== null) {
    const grown = new Map(lowerIslands);
    for (const [name, island] of pre) grown.set(name, island);
    known = grown;
  }
  for (const name of known.keys()) refused.add(name);
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
  // Who else must see the patch (H3.4): every non-islanded module that
  // reads a patched member through the builtin's CommonJS object. An npm
  // package joins the island set (a patch meant for it must reach it); a
  // user module is SC8020, because native code cannot see the patch.
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
  if (policy.mode === "auto" && patchedMembers.size > 0) {
    for (const m of scan.modules) {
      if (modules.has(m.file)) continue;
      for (const read of m.cjsReads) {
        const patchFile = patchFileOf(patchedMembers, read.member);
        if (patchFile === undefined) continue;
        if (m.origin === "npm" && m.packageName !== null && m.packageDir !== null) {
          if (!readerPackages.has(m.packageName) && !refused.has(m.packageName))
            readerPackages.set(m.packageName, {
              packageDir: m.packageDir,
              member: read.member,
              patchFile,
            });
        } else if (m.origin === "user") {
          errors.push(nodeIslandPatchedReadDiag(read.member, patchFile, read.loc));
        }
      }
    }
  }
  if (errors.length > 0)
    return { packages: new Map(), modules: new Map(), notes: [], errors, graph: null };
  if (
    refused.size === 0 &&
    policy.forcedNode.size === 0 &&
    modules.size === 0 &&
    readerPackages.size === 0
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
    if (packages.has(name) || known.has(name)) continue;
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
  for (const [name, island] of known) {
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
    : { packages, modules, notes, errors, graph: pre };
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
  growEsmImporters(policy, compiled, edges, grown);
  return grown.size === known.size ? null : grown;
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
    // Packages run in Node through their own decision (loweringIslands).
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
