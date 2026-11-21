import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BIGINT_T, DYN, F64, type IrExpr, VOID } from "../../../ir/ir.js";

/** A value whose checker type is node:perf_hooks' SlidingWindowHistogram.
 * Its runtime value is the sliding-window handle behind a dyn box. */
function isSlidingWindowHistogram(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined) return false;
  return ts.symbolName(symbol) === "SlidingWindowHistogram" && lowerer.isStdlibSymbol(symbol);
}

/** createSlidingWindowHistogram(options): the options are one dyn value; the
 * runtime applies Node's validation and defaults. */
export function lowerCreateSlidingWindowHistogramCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
): IrExpr {
  const loc = locOf(expr);
  const args = expr.arguments.nodes;
  if (args.length !== 1 || ts.isSpreadElement(args[0]!)) {
    lowerer.noLowering(
      "this createSlidingWindowHistogram call form",
      expr,
      "pass one options object",
    );
  }
  return {
    kind: "libCall",
    fn: "perf.slidingNew",
    args: [lowerer.lowerExprExpecting(args[0]!, DYN)],
    type: DYN,
    loc,
  };
}

/** record(val), reset() and snapshot() on a SlidingWindowHistogram. The
 * runtime validates the recorded value; snapshot answers a Histogram. */
export function lowerSlidingWindowMethodCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken || !isSlidingWindowHistogram(lowerer, access.expression)) return null;
  const loc = locOf(expr);
  const name = access.name.text;
  const args = expr.arguments.nodes;
  const handle = (): IrExpr => lowerer.lowerExprExpecting(access.expression, DYN);
  if (name === "reset" && args.length === 0) {
    return { kind: "libCall", fn: "perf.slidingReset", args: [handle()], type: VOID, loc };
  }
  if (name === "snapshot" && args.length === 0) {
    return { kind: "libCall", fn: "perf.slidingSnapshot", args: [handle()], type: DYN, loc };
  }
  if (name === "record" && args.length === 1 && !ts.isSpreadElement(args[0]!)) {
    const argType = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
    if (argType?.kind === "bigint") {
      return {
        kind: "libCall",
        fn: "perf.slidingRecordBig",
        args: [handle(), lowerer.lowerExprExpecting(args[0]!, BIGINT_T)],
        type: VOID,
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "perf.slidingRecord",
      args: [handle(), lowerer.lowerExprExpecting(args[0]!, F64)],
      type: VOID,
      loc,
    };
  }
  return null;
}
