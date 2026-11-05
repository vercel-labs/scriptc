import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { isStdlibGlobal } from "../surfaces.js";

/* WHATWG FormData is a native checked-dynamic handle (scr_formdata.c):
 * construction and `instanceof` lower to their libCalls, and every member
 * (append, set, get, getAll, has, delete, entries, keys, values, forEach
 * and Symbol.iterator) dispatches through the handle exactly as undici
 * implements it. FormData never has a static representation: like Blob and
 * File, type-mapper.ts maps the stdlib interface to DYN. */

/** `new FormData(...)`: the argument vector goes to the runtime, which
 * takes no form element (Node has none) and throws undici's conversion
 * TypeError for any argument but undefined. */
export function lowerFormDataNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!lowerer.isStdlibGlobal(expr.expression, "FormData")) return null;
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(expr);
  const values = args.map((arg) => lowerer.lowerExprExpecting(arg, DYN));
  return {
    kind: "libCall",
    fn: "formdata.new",
    args: [{ kind: "dynArrLit", elems: values, type: DYN, loc }],
    type: DYN,
    loc,
  };
}

/** `v instanceof FormData`. */
export function lowerFormDataInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isStdlibGlobal(lowerer, expr.right, "FormData")) return null;
  const loc = locOf(expr);
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return { kind: "libCall", fn: "formdata.is", args: [value], type: BOOL, loc };
}
