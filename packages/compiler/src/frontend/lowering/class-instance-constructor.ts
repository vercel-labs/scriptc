import * as ts from "../ts7/adapter.js";
import { DYN, STRING, type IrExpr } from "../../ir/ir.js";
import { varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import { type Lowerer } from "./lowerer.js";
import { checkedClassConstruction } from "./class-construction.js";

/** Select the instance's concrete class before evaluating constructor
 * arguments. Each branch completes arguments against its own constructor,
 * including subclasses with different defaults or parameter counts. */
export function lowerInstanceConstructorNew(
  lowerer: Lowerer,
  expr: ts.NewExpression,
): IrExpr | null {
  let access = expr.expression;
  while (ts.isParenthesizedExpression(access)) access = access.expression;
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.name.text !== "constructor" ||
    access.questionDotToken
  )
    return null;
  let receiver = lowerer.lowerExpr(access.expression);
  const declared =
    receiver.type.kind === "dyn" ? lowerer.mapTypeOf(lowerer.typeOf(access.expression)) : null;
  if (declared?.kind === "object") receiver = lowerer.coerceToExpected(receiver, declared);
  if (receiver.type.kind !== "object") return null;
  const info = lowerer.classes.get(receiver.type.className);
  if (!info || info.def.runtime) return null;
  const loc = locOf(expr);
  const local = lowerer.declareHiddenLocal("%constructorReceiver", receiver.type);
  const value = varRef(local.id, receiver.type, loc);
  // Use the incremental checked constructor dispatcher. Enumerating the
  // whole declared hierarchy here would make every imported subclass
  // constructible merely because a base implements clone().
  const constructor: IrExpr = {
    kind: "dynKeyGet",
    value: lowerer.coerceToExpected(value, DYN),
    key: { kind: "strLit", value: "constructor", type: STRING, loc },
    type: DYN,
    loc,
  };
  const result = checkedClassConstruction(
    lowerer,
    constructor,
    (expr.arguments?.nodes ?? []).map((argument) => lowerer.lowerExprExpecting(argument, DYN)),
    loc,
  );
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: receiver, loc }],
    result: lowerer.coerceToExpected(result, receiver.type),
    type: receiver.type,
    loc,
  };
}
