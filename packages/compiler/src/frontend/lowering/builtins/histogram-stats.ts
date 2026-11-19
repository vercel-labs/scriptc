import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { dynUndefinedExpr, numLit, varRef } from "../../../ir/build.js";
import { DYN, F64, type IrExpr, type IrLibFn, type IrType, VOID } from "../../../ir/ir.js";

/** A receiver of the Histogram base interface: createHistogram's classes and
 * monitorEventLoopDelay's interval histogram. */
function isHistogramReceiver(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined) return false;
  const name = ts.symbolName(symbol);
  return (
    (name === "Histogram" || name === "RecordableHistogram" || name === "IntervalHistogram") &&
    lowerer.isStdlibSymbol(symbol)
  );
}

/** meanCI, percentileCI and welchTest: a record whose fields are runtime
 * selectors over inputs prepared once. Node validates the percentile, the
 * other histogram and the confidence option in that order before computing. */
export function lowerHistogramStatsMethodCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const name = access.name.text;
  if (name !== "meanCI" && name !== "percentileCI" && name !== "welchTest") return null;
  if (access.questionDotToken || !isHistogramReceiver(lowerer, access.expression)) return null;
  const loc = locOf(expr);
  const args = expr.arguments.nodes;
  if (args.some(ts.isSpreadElement)) {
    lowerer.noLowering(`Histogram.${name} with spread arguments`, expr);
  }
  const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (result?.kind !== "record") {
    lowerer.noLowering(`Histogram.${name} with this result type`, expr);
  }
  const shape = lowerer.shapes.get(result.shapeId);
  if (shape === undefined) lowerer.noLowering(`Histogram.${name} with this result type`, expr);
  const h = lowerer.declareHiddenLocal("%histogram", DYN);
  const hRef = (): IrExpr => varRef(h.id, DYN, loc);
  const call = (fn: IrLibFn, type: IrType, callArgs: IrExpr[]): IrExpr => ({
    kind: "libCall",
    fn,
    args: callArgs,
    type,
    loc,
  });
  const confidenceArg = (index: number): IrExpr =>
    args[index] === undefined
      ? dynUndefinedExpr(loc)
      : lowerer.lowerExprExpecting(args[index]!, DYN);
  const resultFields = (values: Record<string, IrExpr>): { name: string; value: IrExpr }[] =>
    shape.fields.map((field) => ({
      name: field.name,
      value: values[field.name] ?? lowerer.noLowering(`Histogram.${name} result field`, expr),
    }));

  if (name === "meanCI") {
    if (args.length > 1) lowerer.noLowering("Histogram.meanCI with this argument shape", expr);
    const c = lowerer.declareHiddenLocal("%confidence", F64);
    const cRef = (): IrExpr => varRef(c.id, F64, loc);
    const reading = (which: number): IrExpr =>
      call("perf.histoMeanCI", F64, [hRef(), cRef(), numLit(which, loc)]);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: h.id,
          init: lowerer.lowerExprExpecting(access.expression, DYN),
          loc,
        },
        {
          kind: "varDecl",
          localId: c.id,
          init: call("perf.histoConfidence", F64, [confidenceArg(0)]),
          loc,
        },
      ],
      result: {
        kind: "recordLit",
        fields: resultFields({ mean: reading(0), lower: reading(1), upper: reading(2) }),
        type: result,
        loc,
      },
      type: result,
      loc,
    };
  }

  if (name === "percentileCI") {
    if (args.length < 1 || args.length > 2) {
      lowerer.noLowering("Histogram.percentileCI with this argument shape", expr);
    }
    const p = lowerer.declareHiddenLocal("%percentile", F64);
    const c = lowerer.declareHiddenLocal("%confidence", F64);
    const pRef = (): IrExpr => varRef(p.id, F64, loc);
    const cRef = (): IrExpr => varRef(c.id, F64, loc);
    const reading = (which: number): IrExpr =>
      call("perf.histoPercentileCI", F64, [hRef(), pRef(), cRef(), numLit(which, loc)]);
    return {
      kind: "seqExpr",
      stmts: [
        {
          kind: "varDecl",
          localId: h.id,
          init: lowerer.lowerExprExpecting(access.expression, DYN),
          loc,
        },
        {
          kind: "varDecl",
          localId: p.id,
          init: call("perf.histoPercentileArg", F64, [lowerer.lowerExprExpecting(args[0]!, DYN)]),
          loc,
        },
        {
          kind: "varDecl",
          localId: c.id,
          init: call("perf.histoConfidence", F64, [confidenceArg(1)]),
          loc,
        },
      ],
      result: {
        kind: "recordLit",
        fields: resultFields({ value: reading(0), lower: reading(1), upper: reading(2) }),
        type: result,
        loc,
      },
      type: result,
      loc,
    };
  }

  // welchTest(other[, options])
  if (args.length < 1 || args.length > 2) {
    lowerer.noLowering("Histogram.welchTest with this argument shape", expr);
  }
  const o = lowerer.declareHiddenLocal("%other", DYN);
  const c = lowerer.declareHiddenLocal("%confidence", F64);
  const oRef = (): IrExpr => varRef(o.id, DYN, loc);
  const cRef = (): IrExpr => varRef(c.id, F64, loc);
  const reading = (which: number): IrExpr =>
    call("perf.histoWelch", F64, [hRef(), oRef(), cRef(), numLit(which, loc)]);
  const intervalField = shape.fields.find((field) => field.name === "confidenceInterval");
  if (intervalField === undefined || intervalField.type.kind !== "record") {
    lowerer.noLowering("Histogram.welchTest with this result type", expr);
  }
  const intervalShape = lowerer.shapes.get(intervalField.type.shapeId);
  if (intervalShape === undefined) {
    lowerer.noLowering("Histogram.welchTest with this result type", expr);
  }
  const intervalValues: Record<string, IrExpr> = { lower: reading(3), upper: reading(4) };
  const interval: IrExpr = {
    kind: "recordLit",
    fields: intervalShape.fields.map((field) => ({
      name: field.name,
      value:
        intervalValues[field.name] ??
        lowerer.noLowering("Histogram.welchTest interval field", expr),
    })),
    type: intervalField.type,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: h.id,
        init: lowerer.lowerExprExpecting(access.expression, DYN),
        loc,
      },
      {
        kind: "varDecl",
        localId: o.id,
        init: lowerer.lowerExprExpecting(args[0]!, DYN),
        loc,
      },
      { kind: "exprStmt", expr: call("perf.histoOther", VOID, [oRef()]), loc },
      {
        kind: "varDecl",
        localId: c.id,
        init: call("perf.histoConfidence", F64, [confidenceArg(1)]),
        loc,
      },
    ],
    result: {
      kind: "recordLit",
      fields: resultFields({
        tStatistic: reading(0),
        degreesOfFreedom: reading(1),
        pValue: reading(2),
        confidenceInterval: interval,
      }),
      type: result,
      loc,
    },
    type: result,
    loc,
  };
}
