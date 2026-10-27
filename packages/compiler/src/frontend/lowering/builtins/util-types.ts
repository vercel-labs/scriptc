import { dynUndefinedExpr, strLit, varRef } from "../../../ir/build.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { BOOL, DYN, type IrExpr, type IrStmt, type SrcLoc } from "../../../ir/ir.js";

export function lowerUtilTypeCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
  name: string,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with spread arguments`, expr);
  const first = expr.arguments.nodes[0];
  if (first !== undefined && lowerer.mapTypeOf(lowerer.typeOf(first))?.kind === "date") {
    // A Date value has no checked-dynamic form; its static type decides
    // every brand. The arguments still evaluate in order.
    return {
      kind: "seqExpr",
      stmts: expr.arguments.nodes.map((arg): IrStmt => ({
        kind: "exprStmt",
        expr: lowerer.lowerExpr(arg),
        loc,
      })),
      result: { kind: "boolLit", value: bi.member === "isDate", type: BOOL, loc },
      type: BOOL,
      loc,
    };
  }
  const input = expr.arguments.nodes[0]
    ? lowerer.lowerExprExpecting(expr.arguments.nodes[0], DYN)
    : dynUndefinedExpr(loc);
  const saved = lowerer.declareHiddenLocal("%utilTypeInput", DYN);
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: saved.id, init: input, loc },
      ...expr.arguments.nodes
        .slice(1)
        .map((arg): IrStmt => ({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc })),
    ],
    result: {
      kind: "libCall",
      fn: "util.typeIs",
      args: [varRef(saved.id, DYN, loc), strLit(bi.member, loc)],
      type: BOOL,
      loc,
    },
    type: BOOL,
    loc,
  };
}
