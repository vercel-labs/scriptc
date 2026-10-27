/* Shape inference for untyped npm JavaScript
 * (results/design-shape-inference/DESIGN.md): the report (S1) and the typed
 * overlay (overlay.ts). */
import type * as ts from "../ts7/adapter.js";
import type { IrFunction } from "../../ir/ir.js";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import { isShapelessPackage } from "../package-shims.js";
import { analyzeShapes, isPackageJsFile } from "./analyze.js";
import { OVERLAY_MARK, planShapeOverlay } from "./overlay.js";
import { buildShapeReport } from "./report.js";
import { computeConstantGraphs, constantGraphReport } from "./constant-graphs.js";

export { analyzeShapes } from "./analyze.js";
export { buildShapeReport } from "./report.js";

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

export function resetShapeOverlay(): void {
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

/** loadProgram7's overlayer: analyze, plan, and register the overlay files. */
export function shapeOverlayer(program: ts.Program): ReadonlyMap<string, string> | null {
  resetShapeOverlay();
  const analysis = analyzeShapes(program, program.getTypeChecker());
  if (analysis.budgetExceeded) return null;
  const report = buildShapeReport(analysis, "1");
  const packageFiles = analysis.files.filter((sf) => {
    if (!isPackageJsFile(sf)) return false;
    const pkg = npmStaticPackageOfPath(sf.fileName);
    return pkg === null || !isShapelessPackage(pkg);
  });
  const overlay = planShapeOverlay(analysis, report.sites, packageFiles);
  overlayFiles = new Set(overlay.files.keys());
  overlayAnnotations = overlay.annotations;
  overlayDeadBranches = overlay.deadBranches;
  if (process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] !== undefined) {
    for (const [file, text] of overlay.files)
      process.stderr.write(`[shape-overlay] ${file}\n${text}\n`);
  }
  return overlay.files;
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
      loc?: { file: string; start: number };
      inferredSite?: string;
    };
    if (node.kind === "dynCheck" && node.loc !== undefined && overlayFiles.has(node.loc.file)) {
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
  if (overlayFiles.size === 0) return [];
  const packages = new Set([...overlayFiles].map((f) => npmStaticPackageOfPath(f) ?? f));
  return [
    {
      code: "SC6103",
      message:
        `shape inference typed ${overlayAnnotations} declarations in ${overlayFiles.size} files of ${packages.size} ` +
        `package${packages.size === 1 ? "" : "s"} (${[...packages].sort().join(", ")}); the build checks ` +
        `${inferredFactChecks} inferred fact${inferredFactChecks === 1 ? "" : "s"} at run time` +
        (overlayDeadBranches > 0
          ? ` and replaces ${overlayDeadBranches} branch${overlayDeadBranches === 1 ? "" : "es"} it proved unreachable with checks`
          : ""),
      loc: { file: entryFile, start: 0, end: 0 },
      hint: "a failing check reports a scriptc analysis bug; --no-shape-overlay compiles without the overlay",
    },
  ];
}
