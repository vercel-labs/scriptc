import * as ts from "../../ts7/adapter.js";
import { locOf } from "../../program.js";
import { varRef } from "../../../ir/build.js";
import { DYN, type IrExpr, type IrStmt, isUnitType } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";
import { completeFuncValueArgs } from "../call-arguments.js";
import { lowerOptionalNumber } from "../lower-exprs.js";
import { lowerSafeIndexRead } from "../array-values.js";

/** Retain native function slots during indexed calls. The array remains
 * the receiver, and the selected callback is captured before arguments
 * can replace it. Missing slots throw only after argument evaluation. */
export function lowerArrayCallbackCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.ElementAccessExpression,
  array: IrExpr,
): IrExpr | null {
  if (array.type.kind !== "array" || call.arguments.some(ts.isSpreadElement)) return null;
  const elem = array.type.elem;
  const arms = elem.kind === "union" ? (lowerer.unions.get(elem.unionId)?.arms ?? []) : [elem];
  const functions = arms.filter((arm) => arm.kind === "func");
  const fn = functions[0];
  if (
    functions.length !== 1 ||
    fn?.kind !== "func" ||
    !arms.every((arm) => arm.kind === "func" || isUnitType(arm)) ||
    fn.rest
  )
    return null;
  if (!(lowerer.typeOf(access.argumentExpression).flags & ts.TypeFlags.NumberLike)) return null;
  const loc = locOf(call);
  const statements: IrStmt[] = [];
  const store = (value: IrExpr, prefix: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(prefix, value.type);
    statements.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return varRef(local.id, local.type, loc);
  };
  const receiver = store(array, "%callbackArray");
  const index = lowerOptionalNumber(
    lowerer,
    lowerer.lowerExpr(access.argumentExpression),
    locOf(access.argumentExpression),
    access.argumentExpression,
  );
  const read = lowerSafeIndexRead(lowerer, receiver, index, loc);
  if (!read || read.type.kind !== "union") return null;
  const callee = store(read, "%arrayCallback");
  const args = completeFuncValueArgs(lowerer, call, fn, loc).map((arg) =>
    store(arg, "%callbackArg"),
  );
  const helper = lowerer.narrowedArmHelper(read.type.unionId, fn, loc);
  if (!helper) return null;
  const result: IrExpr = {
    kind: "callValue",
    callee: { kind: "call", callee: helper, args: [callee], type: fn, loc },
    receiver: lowerer.coerceToExpected(receiver, DYN),
    args,
    type: fn.ret,
    loc,
  };
  return { kind: "seqExpr", stmts: statements, result, type: result.type, loc };
}
