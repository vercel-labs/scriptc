/* Shape inference for untyped npm JavaScript
 * (results/design-shape-inference/DESIGN.md): the report (S1) and the typed
 * overlay (overlay.ts). */
import type * as ts from "../ts7/adapter.js";
import type { IrFunction } from "../../ir/ir.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { isShapelessPackage } from "../package-shims.js";
import { analyzeShapes, isPackageJsFile, type ShapeAnalysis } from "./analyze.js";
import { createHash } from "node:crypto";
import {
  hasShapeOverlayProtectedSpans,
  OVERLAY_MARK,
  planOnRewrittenTexts,
  planShapeOverlay,
  renderShapeOverlay,
  type OverlayExclusions,
  type ShapeOverlayPlan,
} from "./overlay.js";
import { attributeOverlayRefusals } from "./fallback.js";
import { checksInferredFact } from "./inferred-checks.js";
import {
  planStaticObjectRewrites,
  rewrittenPosition,
  type StaticObjectRewrites,
} from "./static-objects.js";
import { isJsSourceFile } from "../program.js";
import { buildShapeReport } from "./report.js";
import { computeConstantGraphs, constantGraphReport } from "./constant-graphs.js";
import {
  overlayMemoKey,
  readOverlayMemo,
  shapeOverlayMemoEnabled,
  textHash,
  writeOverlayMemo,
  type OverlayMemo,
} from "./memo.js";

export { analyzeShapes } from "./analyze.js";
export { buildShapeReport } from "./report.js";
export { setShapeOverlayMemoDir } from "./memo.js";
export { setShapeOverlayProtectedSpans } from "./overlay.js";

/** SCRIPTC_DEBUG_SHAPES: `1` reports package code in hot functions,
 * `verbose` every package site, `all` user files too, any other value only
 * files whose path contains it. Writes to stderr; changes nothing else. The
 * build cache does not key on the variable: use SCRIPTC_NO_CACHE=1. */
export function reportShapes(program: ts.Program, filter: string): void {
  const start = performance.now();
  const analysis = analyzeShapes(program, program.getTypeChecker());
  // `const`: the constant object graphs (DESIGN-constant-objects.md, stage 1).
  const lines =
    filter === "const"
      ? constantGraphReport(analysis, computeConstantGraphs(analysis))
      : buildShapeReport(analysis, filter).lines;
  const ms = (performance.now() - start).toFixed(0);
  process.stderr.write(`[shapes] ${ms} ms\n${lines.map((l) => `[shapes] ${l}`).join("\n")}\n`);
}

/* The overlay's files for the current load: the lowering treats them as
 * checked JavaScript (their JSDoc types are the analysis's proven facts). */
let overlayFiles: ReadonlySet<string> = new Set();
let overlayAnnotations = 0;
let overlayDeadBranches = 0;

export function isShapeOverlayFile(fileName: string): boolean {
  return overlayFiles.has(fileName);
}

/** Whether a statement or declaration carries an overlay annotation. */
export function shapeOverlayAnnotated(node: ts.Node): boolean {
  const sf = node.getSourceFile();
  if (!overlayFiles.has(sf.fileName)) return false;
  return sf.text.slice(node.pos, node.getStart(sf)).includes(OVERLAY_MARK);
}

export function shapeOverlayFileNames(): readonly string[] {
  return [...overlayFiles];
}

export function shapeOverlayAnnotationCount(): number {
  return overlayAnnotations;
}

/** The overlay's per-load state (the registry is per process, and a later
 * load resets it): a load captures it, and the lowering of that load
 * restores it. */
export interface ShapeOverlayLoadState {
  readonly renderedFiles: ReadonlySet<string>;
  readonly staticRewriteFiles: ReadonlySet<string>;
  readonly staticObjectStats: typeof staticObjectStats;
  readonly overlayDone: boolean;
  readonly overlayFiles: ReadonlySet<string>;
  readonly overlayAnnotations: number;
  readonly overlayDeadBranches: number;
}

export function captureShapeOverlayState(): ShapeOverlayLoadState {
  return {
    renderedFiles,
    staticRewriteFiles,
    staticObjectStats,
    overlayDone,
    overlayFiles,
    overlayAnnotations,
    overlayDeadBranches,
  };
}

export function restoreShapeOverlayState(state: ShapeOverlayLoadState): void {
  renderedFiles = state.renderedFiles;
  staticRewriteFiles = state.staticRewriteFiles;
  staticObjectStats = state.staticObjectStats;
  overlayDone = state.overlayDone;
  overlayFiles = state.overlayFiles;
  overlayAnnotations = state.overlayAnnotations;
  overlayDeadBranches = state.overlayDeadBranches;
}

export function resetShapeOverlay(): void {
  renderedFiles = new Set();
  staticRewriteFiles = new Set();
  staticObjectStats = {
    classes: 0,
    functions: 0,
    directCalls: 0,
    tableDispatches: 0,
    foldedReads: 0,
  };
  overlayDone = false;
  overlayFiles = new Set();
  overlayAnnotations = 0;
  overlayDeadBranches = 0;
  inferredFactChecks = 0;
}

/** Whether the overlay runs. While it is new it is opt-in
 * (SCRIPTC_SHAPE_OVERLAY=1); `--no-shape-overlay` (the `shapeOverlay:
 * false` build option) sets the variable to 0 for the build. */
export function shapeOverlayEnabled(): boolean {
  return process.env["SCRIPTC_SHAPE_OVERLAY"] === "1";
}

/* The build's fallback state (fallback.ts): annotations and files whose
 * lowering was refused, and whether the build dropped the overlay. It
 * outlives the loads of one build. */
let exclusions: { annotations: Map<string, Set<number>>; files: Set<string> } = {
  annotations: new Map(),
  files: new Set(),
};
let overlayDropped = false;
let droppedAnnotations = 0;
/* The annotations dropped before a comparison load turned the overlay off
 * for a moment (setShapeOverlayDropped). */
let droppedBeforeComparison = 0;

/* The build's memo (memo.ts): its key, what an earlier build recorded, the
 * hashes of the JavaScript files as written, and the last overlay plan. */
let memoKey: string | null = null;
let memo: OverlayMemo | null = null;
let memoOff = false;
let asWrittenHashes = new Map<string, string>();
let lastPlan: ShapeOverlayPlan | null = null;
let memoSeededPlan: ShapeOverlayPlan | null = null;

/** Starts a build: no annotation is excluded yet. */
export function beginShapeOverlayBuild(): void {
  overlayCache = new Map();
  exclusions = { annotations: new Map(), files: new Set() };
  overlayDropped = false;
  droppedAnnotations = 0;
  droppedBeforeComparison = 0;
  memoKey = null;
  memo = null;
  memoOff = false;
  asWrittenHashes = new Map();
  lastPlan = null;
  memoSeededPlan = null;
}

/** Turns the overlay off for the rest of the build (true), or back on
 * (false): the pipeline compares a load without it when the overlay's
 * program fails a check the program without it passes. */
export function setShapeOverlayDropped(dropped: boolean): void {
  if (dropped && !overlayDropped) droppedBeforeComparison = droppedAnnotations;
  overlayDropped = dropped;
  droppedAnnotations = dropped ? overlayAnnotations : droppedBeforeComparison;
}

/** The memo's deferred refusals of the build without the overlay, if an
 * earlier build of the same JavaScript recorded them. */
export function shapeOverlayMemoPlainFences(): ReadonlySet<string> | null {
  return memo === null || memo.plainFences.length === 0 ? null : new Set(memo.plainFences);
}

/** Records the build's verdicts for the next build of the same
 * JavaScript (memo.ts): the refused annotations and files, whether the
 * build compiled without the overlay, and the deferred refusals of the
 * build without it (`plainFences`, from a comparison). */
export function recordShapeOverlayMemo(plainFences: Iterable<string> | null): void {
  if (memoKey === null || !shapeOverlayMemoEnabled() || memoOff) return;
  const annotations: { file: string; hash: string; ids: number[] }[] = [];
  for (const [file, ids] of exclusions.annotations) {
    const part = lastPlan?.parts.get(file);
    if (part === undefined || ids.size === 0) continue;
    annotations.push({ file, hash: textHash(part.text), ids: [...ids].sort((a, b) => a - b) });
  }
  annotations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const files: { file: string; hash: string }[] = [];
  for (const file of [...exclusions.files].sort()) {
    const hash = asWrittenHashes.get(file);
    if (hash !== undefined) files.push({ file, hash });
  }
  const plain = new Set(memo?.plainFences ?? []);
  for (const k of plainFences ?? []) plain.add(k);
  const next: OverlayMemo = {
    off: overlayDropped,
    annotations,
    files,
    plainFences: [...plain].sort(),
  };
  if (memo !== null && JSON.stringify(memo) === JSON.stringify(next)) return;
  writeOverlayMemo(memoKey, next);
  memo = next;
}

/* Round 0 of a load: the memo of the program's JavaScript, read once per
 * key. A memo that says the build compiled without the overlay turns it
 * off before any analysis; whole-file exclusions apply to files whose text
 * is unchanged. */
function readMemoFor(program: ts.Program): void {
  if (!shapeOverlayMemoEnabled()) return;
  const js = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && isJsSourceFile(sf));
  const key = overlayMemoKey(js.map((sf) => [sf.fileName, sf.text] as const));
  if (key === memoKey) return;
  memoKey = key;
  asWrittenHashes = new Map(js.map((sf) => [sf.fileName, textHash(sf.text)] as const));
  memo = readOverlayMemo(key);
  memoOff = false;
  if (memo === null) return;
  if (memo.off) {
    memoOff = true;
    overlayDropped = true;
    return;
  }
  for (const f of memo.files)
    if (asWrittenHashes.get(f.file) === f.hash) exclusions.files.add(f.file);
}

/* Applies the memo's refused annotations to a plan, once per plan: ids
 * count only for a file whose overlay input text is unchanged. */
function seedMemoAnnotations(plan: ShapeOverlayPlan): void {
  if (memo === null || memoSeededPlan === plan) return;
  memoSeededPlan = plan;
  for (const a of memo.annotations) {
    const part = plan.parts.get(a.file);
    if (part === undefined || textHash(part.text) !== a.hash) continue;
    let set = exclusions.annotations.get(a.file);
    if (set === undefined) exclusions.annotations.set(a.file, (set = new Set()));
    for (const id of a.ids) {
      if (set.has(id)) continue;
      set.add(id);
      droppedAnnotations++;
    }
  }
}

/** Whether the current load has overlay files or structural rewrites. */
export function shapeOverlayActive(): boolean {
  const { classes, functions } = staticObjectStats;
  return (
    overlayFiles.size > 0 ||
    renderedFiles.size > 0 ||
    staticRewriteFiles.size > 0 ||
    classes + functions > 0
  );
}

/** The overlay's answer to refused lowering diagnostics: it excludes what
 * the refusals depend on, at the given level, and says whether a reload
 * can change anything.
 * - "annotations": the blamed annotations (or, for a blamed file without
 *   blamed annotations, that file);
 * - "fences": like "annotations", for refusals deferred to run time, and
 *   never a whole file;
 * - "files": every overlay file involved;
 * - "all": the whole overlay. */
export function excludeRefusedOverlay(
  program: ts.Program,
  diagnostics: readonly ScrDiagnostic[],
  level: "annotations" | "files" | "all" | "fences",
): boolean {
  if (overlayDropped) return false;
  const files = new Set([...overlayFiles, ...renderedFiles]);
  // Files with structural rewrites only also count as overlay files.
  for (const f of staticRewriteFiles) files.add(f);
  if (level === "all") {
    overlayDropped = true;
    droppedAnnotations = overlayAnnotations;
    return true;
  }
  const blame = attributeOverlayRefusals(program, diagnostics, files, level !== "fences");
  if (process.env["SCRIPTC_DEBUG_SHAPE_FALLBACK"] === "all")
    for (const [file, ids] of blame.annotations)
      process.stderr.write(
        `[shape-fallback] ${level} blames ${file.split("/").slice(-2).join("/")}: ${[...ids].join(",")}\n`,
      );
  let changed = false;
  for (const file of blame.files) {
    const ids = blame.annotations.get(file);
    // Deferred refusals drop only the annotations they are blamed on.
    if (level === "fences" && ids === undefined) continue;
    if (level === "files" || ids === undefined) {
      if (!exclusions.files.has(file)) {
        exclusions.files.add(file);
        changed = true;
      }
      continue;
    }
    let set = exclusions.annotations.get(file);
    if (set === undefined) exclusions.annotations.set(file, (set = new Set()));
    for (const id of ids) {
      if (set.has(id)) continue;
      set.add(id);
      droppedAnnotations++;
      changed = true;
    }
  }
  return changed;
}

let staticRewriteFiles: ReadonlySet<string> = new Set();
/** Every file the typed round rewrote (typed or only neutralized). */
let renderedFiles: ReadonlySet<string> = new Set();

function overlayExclusions(): OverlayExclusions {
  return exclusions;
}

/* Per build, the overlay's analysis-dependent results by program text and
 * excluded files: a reload that only drops refused annotations renders the
 * cached plan instead of analyzing again (fallback.ts). */
interface OverlayCacheEntry {
  budgetExceeded?: true;
  rewrites?: StaticObjectRewrites;
  plan?: ShapeOverlayPlan;
}
let overlayCache = new Map<string, OverlayCacheEntry>();

function programTextKey(program: ts.Program): string {
  const hash = createHash("sha256");
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    hash.update(sf.fileName).update("\0").update(sf.text).update("\0");
  }
  return hash.digest("hex");
}

/** Per-call-site clones serve the constant-graph facts (stage 3); the
 * overlay's rewrites and types do not use them yet, so its analyses run
 * without them unless SCRIPTC_SHAPE_SITE_CLONES asks. */
function overlaySiteClones(): number {
  const env = process.env["SCRIPTC_SHAPE_SITE_CLONES"];
  return env === undefined ? 0 : Number(env);
}

function overlayJsFiles(analysis: ShapeAnalysis): ts.SourceFile[] {
  // Package JavaScript of packages that keep shapes on, and the program's
  // own JavaScript files. Inference for the program's JavaScript alone
  // (SCRIPTC_INFER_JS=1 without SCRIPTC_SHAPE_OVERLAY=1) leaves packages as
  // they are.
  return analysis.files.filter((sf) => {
    if (sf.isDeclarationFile || !isJsSourceFile(sf)) return false;
    if (!isPackageJsFile(sf)) return !sf.fileName.includes("/node_modules/");
    if (!shapeOverlayEnabled()) return false;
    const pkg = npmStaticPackageOfPath(sf.fileName);
    return pkg === null || !isShapelessPackage(pkg);
  });
}

/** loadProgram7's overlayer: analyze, plan, and register the overlay files. */
export function shapeOverlayer(
  program: ts.Program,
  round: number,
): ReadonlyMap<string, string> | null {
  if (round === 0) {
    resetShapeOverlay();
    readMemoFor(program);
  }
  if (overlayDropped) return null;
  const key = `${programTextKey(program)}|${[...exclusions.files].sort().join(",")}`;
  const cached = overlayCache.get(key);
  const entry: OverlayCacheEntry = cached ?? {};
  if (cached === undefined) overlayCache.set(key, entry);
  if (entry.budgetExceeded === true) return null;
  let analysis: ShapeAnalysis | null = null;
  const analyzed = (): ShapeAnalysis | null => {
    if (analysis === null) {
      const t0 = performance.now();
      analysis = analyzeShapes(program, program.getTypeChecker(), {
        siteClones: overlaySiteClones(),
      });
      if (process.env["SCRIPTC_DEBUG_SHAPE_TIME"] !== undefined)
        process.stderr.write(
          `[shape-time] round ${round} analysis ${(performance.now() - t0).toFixed(0)} ms\n`,
        );
    }
    if (analysis.budgetExceeded) {
      entry.budgetExceeded = true;
      return null;
    }
    return analysis;
  };
  // Round 0: the structural rewrites (static-objects.ts); the program is
  // rebuilt from them and analyzed again before the typed overlay.
  if (round === 0 && process.env["SCRIPTC_SHAPE_STATIC_OBJECTS"] !== "0") {
    if (entry.rewrites === undefined) {
      const a = analyzed();
      if (a === null) return null;
      entry.rewrites = planStaticObjectRewrites(
        a,
        // Files a project type patch edited stay as served: the patch's
        // spans are offsets in that text.
        overlayJsFiles(a).filter(
          (sf) => !exclusions.files.has(sf.fileName) && !hasShapeOverlayProtectedSpans(sf.fileName),
        ),
      );
    }
    const rewrites = entry.rewrites;
    staticRewriteFiles = new Set(rewrites.files.keys());
    staticObjectStats = {
      classes: rewrites.classes,
      functions: rewrites.functions,
      directCalls: rewrites.directCalls,
      tableDispatches: rewrites.tableDispatches,
      foldedReads: rewrites.foldedReads,
    };
    if (process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] !== undefined) {
      for (const k of rewrites.kept) process.stderr.write(`[static-objects] kept ${k}\n`);
      for (const [file, text] of rewrites.files)
        process.stderr.write(`[static-objects] ${file}\n${text}\n`);
    }
    if (rewrites.files.size > 0) {
      // Rewrites that only replace constant reads keep every declaration
      // where it is: the typed overlay is planned on this analysis and
      // moved onto the rewritten texts, so the program is rebuilt and
      // analyzed once instead of twice. Hoisting classes or functions
      // changes the declarations: the rewritten program is analyzed again.
      const compose =
        rewrites.classes + rewrites.functions === 0 && process.env["SCRIPTC_SHAPE_COMPOSE"] !== "0";
      if (!compose) return rewrites.files;
      if (entry.plan === undefined) {
        const a = analyzed();
        if (a === null) return null;
        const report = buildShapeReport(a, "1");
        const plan = planShapeOverlay(a, report.sites, overlayJsFiles(a), {
          annotations: new Map(),
          files: exclusions.files,
        });
        const moved = new Map<string, { text: string; map: (pos: number) => number | null }>();
        for (const [file, text] of rewrites.files) {
          const edits = rewrites.edits.get(file) ?? [];
          moved.set(file, { text, map: (pos) => rewrittenPosition(edits, pos) });
        }
        entry.plan = planOnRewrittenTexts(plan, moved);
      }
      const files = renderTyped(entry.plan);
      for (const [file, text] of rewrites.files) if (!files.has(file)) files.set(file, text);
      renderedFiles = new Set(files.keys());
      return files;
    }
  }
  if (round > 1) return null;
  if (entry.plan === undefined) {
    const a = analyzed();
    if (a === null) return null;
    const report = buildShapeReport(a, "1");
    entry.plan = planShapeOverlay(a, report.sites, overlayJsFiles(a), {
      annotations: new Map(),
      files: exclusions.files,
    });
  }
  const files = renderTyped(entry.plan);
  return files.size > 0 ? files : null;
}

/* Renders a typed plan with the build's exclusions and registers the
 * overlay files; the typed overlay is a load's last round. */
function renderTyped(plan: ShapeOverlayPlan): Map<string, string> {
  lastPlan = plan;
  seedMemoAnnotations(plan);
  const overlay = renderShapeOverlay(plan, overlayExclusions());
  overlayFiles = new Set(overlay.typed);
  renderedFiles = new Set(overlay.files.keys());
  overlayAnnotations = overlay.annotations;
  overlayDeadBranches = overlay.deadBranches;
  if (process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] !== undefined) {
    for (const [file, text] of overlay.files)
      process.stderr.write(`[shape-overlay] ${file}\n${text}\n`);
  }
  // The typed overlay is the last round.
  overlayDone = true;
  return overlay.files;
}

let staticObjectStats = {
  classes: 0,
  functions: 0,
  directCalls: 0,
  tableDispatches: 0,
  foldedReads: 0,
};
let overlayDone = false;

/** Whether the overlay has written its last round for this load. */
export function shapeOverlayDone(): boolean {
  return overlayDone;
}

/** Marks the checked conversions lowered in overlay files: each checks an
 * analysis-proven fact, so its failure names the site as an analysis bug. */
export function markInferredFactChecks(
  functions: readonly IrFunction[],
  program: ts.Program,
): number {
  if (overlayFiles.size === 0) return 0;
  let count = 0;
  const lines = new Map<string, (pos: number) => number>();
  const lineOf = (file: string, pos: number): number => {
    let f = lines.get(file);
    if (f === undefined) {
      const sf = program.getSourceFile(file);
      f = sf === undefined ? () => 0 : (p: number) => sf.getLineAndCharacterOfPosition(p).line + 1;
      lines.set(file, f);
    }
    return f(pos);
  };
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const v of x) visit(v);
      return;
    }
    if (x === null || typeof x !== "object") return;
    const node = x as {
      kind?: unknown;
      loc?: { file: string; start: number; end: number };
      inferredSite?: string;
    };
    if (
      node.kind === "dynCheck" &&
      node.loc !== undefined &&
      checksInferredFact(program, node.loc.file, node.loc.start, node.loc.end)
    ) {
      const pkg = npmStaticPackageOfPath(node.loc.file) ?? "";
      const rel = node.loc.file.split("/node_modules/").pop() ?? node.loc.file;
      node.inferredSite = `${pkg} ${rel}:${lineOf(node.loc.file, node.loc.start)}`;
      count++;
    }
    for (const v of Object.values(x)) if (v !== null && typeof v === "object") visit(v);
  };
  for (const fn of functions) visit(fn.body);
  inferredFactChecks = count;
  return count;
}

let inferredFactChecks = 0;

/** Inferred-fact checks inserted by the last build (the build report). */
export function shapeInferredFactCheckCount(): number {
  return inferredFactChecks;
}

/** SC6103, the overlay's build report: what the overlay typed and how many
 * checks of inferred facts the build inserted. A note, never a failure. */
export function shapeOverlayReport(entryFile: string): ScrDiagnostic[] {
  const { classes, functions, directCalls, tableDispatches, foldedReads } = staticObjectStats;
  // Annotations whose lowering was refused (fallback.ts); they compile
  // untyped.
  const fallback = overlayDropped
    ? memoOff
      ? "an earlier build of the same JavaScript compiled without the overlay, so this build does too"
      : "the lowering refused code the overlay typed, so the build compiles without it"
    : droppedAnnotations + exclusions.files.size > 0
      ? `it dropped ${droppedAnnotations} annotation${droppedAnnotations === 1 ? "" : "s"}` +
        (exclusions.files.size > 0
          ? ` and the overlay of ${exclusions.files.size} file${exclusions.files.size === 1 ? "" : "s"}`
          : "") +
        " whose lowering was refused"
      : null;
  if (overlayDropped)
    return [
      {
        code: "SC6103",
        message: `shape inference: ${fallback}`,
        loc: { file: entryFile, start: 0, end: 0 },
        hint: "--no-shape-overlay compiles without the overlay",
      },
    ];
  if (overlayFiles.size === 0 && classes + functions === 0) return [];
  const packages = new Set(
    [...overlayFiles].map((f) => npmStaticPackageOfPath(f) ?? "the program"),
  );
  return [
    {
      code: "SC6103",
      message:
        `shape inference typed ${overlayAnnotations} declarations in ${overlayFiles.size} files of ${packages.size} ` +
        `package${packages.size === 1 ? "" : "s"} (${[...packages].sort().join(", ")}); the build checks ` +
        `${inferredFactChecks} inferred fact${inferredFactChecks === 1 ? "" : "s"} at run time` +
        (overlayDeadBranches > 0
          ? ` and replaces ${overlayDeadBranches} branch${overlayDeadBranches === 1 ? "" : "es"} it proved unreachable with checks`
          : "") +
        (classes + functions > 0
          ? `; it compiled ${classes} constructor function${classes === 1 ? "" : "s"} as classes and ${functions} namespace function${functions === 1 ? "" : "s"} as direct functions (${directCalls} direct call${directCalls === 1 ? "" : "s"}${tableDispatches > 0 ? `, ${tableDispatches} function table call${tableDispatches === 1 ? "" : "s"}` : ""}${foldedReads > 0 ? `, ${foldedReads} constant read${foldedReads === 1 ? "" : "s"}` : ""})`
          : "") +
        (fallback !== null ? `; ${fallback}` : ""),
      loc: { file: entryFile, start: 0, end: 0 },
      hint: "a failing check reports a scriptc analysis bug; --no-shape-overlay compiles without the overlay",
    },
  ];
}
