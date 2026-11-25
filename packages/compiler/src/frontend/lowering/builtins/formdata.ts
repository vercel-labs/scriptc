import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, DYN, F64, type IrExpr, type IrStmt } from "../../../ir/ir.js";
import type { SrcLoc } from "../../../ir/ir.js";
import { stdlibGlobalNameOf } from "../surfaces.js";

/* The global FormData (scr_formdata.c): a checked-dynamic handle over the
 * entry list Node's undici FormData keeps. `new FormData()` and the brand
 * test lower to their runtime entries, the class value is the runtime's
 * class object, and the member calls lower through the handle's
 * checked-dynamic methods (append, set, get, getAll, has, delete). */

/** Whether the expression names Node's global FormData rather than a
 * program binding of the same name. */
export function isFormDataValue(lowerer: Lowerer, node: ts.Expression): boolean {
  return stdlibGlobalNameOf(lowerer, node) === "FormData";
}

/** `new FormData(...)`: the constructor takes no arguments; extra argument
 * expressions still evaluate in order before the call, as in Node. */
export function lowerFormDataNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isFormDataValue(lowerer, expr.expression)) return null;
  const loc = locOf(expr);
  const call: IrExpr = { kind: "libCall", fn: "formdata.new", args: [], type: DYN, loc };
  const args = (expr.arguments?.nodes ?? []).map((arg) => lowerer.lowerExpr(arg));
  if (args.length === 0) return call;
  const stmts = args.map((arg): IrStmt => ({ kind: "exprStmt", expr: arg, loc: arg.loc }));
  return { kind: "seqExpr", stmts, result: call, type: DYN, loc };
}

/** `value instanceof FormData`. */
export function lowerFormDataInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isFormDataValue(lowerer, expr.right)) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "formdata.is",
    args: [value, { kind: "numLit", value: 0, type: F64, loc }],
    type: BOOL,
    loc,
  };
}

/** The FormData class value Node's global names. */
export function formDataClassValue(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "formdata.class", args: [], type: DYN, loc };
}
