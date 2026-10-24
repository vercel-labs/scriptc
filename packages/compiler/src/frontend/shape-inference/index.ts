/* Shape inference for untyped npm JavaScript
 * (results/design-shape-inference/DESIGN.md). Stage S1: report only. */
import type * as ts from "../ts7/adapter.js";
import { analyzeShapes } from "./analyze.js";
import { buildShapeReport } from "./report.js";

export { analyzeShapes } from "./analyze.js";
export { buildShapeReport } from "./report.js";

/** SCRIPTC_DEBUG_SHAPES: `1` reports package code in hot functions,
 * `verbose` every package site, `all` user files too, any other value only
 * files whose path contains it. Writes to stderr; changes nothing else. */
export function reportShapes(program: ts.Program, filter: string): void {
  const start = performance.now();
  const analysis = analyzeShapes(program, program.getTypeChecker());
  const report = buildShapeReport(analysis, filter);
  const ms = (performance.now() - start).toFixed(0);
  process.stderr.write(
    `[shapes] ${ms} ms\n${report.lines.map((l) => `[shapes] ${l}`).join("\n")}\n`,
  );
}
