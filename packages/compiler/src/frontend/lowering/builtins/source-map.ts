import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { dynUndefinedExpr, varRef } from "../../../ir/build.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:module's SourceMap is a native checked-dynamic handle
 * (scr_source_map.c): its type maps to dyn, its payload reads through the
 * handle, findEntry and findOrigin dispatch through it, and these helpers
 * lower the uses a dyn value cannot answer by itself (construction and
 * instanceof). */

/** Whether `node` names module.SourceMap, in any import spelling. */
export function sourceMapClassOf(lowerer: Lowerer, node: ts.Expression): boolean {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  return builtin?.module === "module" && builtin.member === "SourceMap";
}

/** `new SourceMap(payload[, options])`. Arguments evaluate left to right and
 * the surplus ones exist only for their effects, so with any they land in
 * hidden locals in source order before the call reads the two it keeps. */
export function lowerSourceMapNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!sourceMapClassOf(lowerer, expr.expression)) return null;
  const nodes = expr.arguments?.nodes ?? [];
  if (nodes.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const payload =
    nodes.length > 0 ? lowerer.lowerExprExpecting(nodes[0]!, DYN) : dynUndefinedExpr(loc);
  const options =
    nodes.length > 1 ? lowerer.lowerExprExpecting(nodes[1]!, DYN) : dynUndefinedExpr(loc);
  const surplus = nodes.slice(2).map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  if (surplus.length === 0) {
    return { kind: "libCall", fn: "sourceMap.new", args: [payload, options], type: DYN, loc };
  }
  const payloadLocal = lowerer.declareHiddenLocal("%sourceMapPayload", DYN);
  const optionsLocal = lowerer.declareHiddenLocal("%sourceMapOptions", DYN);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: payloadLocal.id, init: payload, loc },
      { kind: "varDecl", localId: optionsLocal.id, init: options, loc },
      ...surplus.map((expr) => ({ kind: "exprStmt" as const, expr, loc: expr.loc })),
    ],
    result: {
      kind: "libCall",
      fn: "sourceMap.new",
      args: [varRef(payloadLocal.id, DYN, loc), varRef(optionsLocal.id, DYN, loc)],
      type: DYN,
      loc,
    },
    type: DYN,
    loc,
  };
}

/** `v instanceof SourceMap`. */
export function lowerSourceMapInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!sourceMapClassOf(lowerer, expr.right)) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return { kind: "libCall", fn: "sourceMap.is", args: [value], type: BOOL, loc };
}
