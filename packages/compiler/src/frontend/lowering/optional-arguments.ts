import * as ts from "../ts7/adapter.js";
import type { IrExpr, IrType, SrcLoc } from "../../ir/ir.js";
import { BOOL, F64, isUnitType, typeEquals } from "../../ir/ir.js";
import { numLit, strLit } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";

/** Lower an expression whose checker type is statically `undefined`/`void`. */
export function lowerStaticallyUndefinedArgument(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const peelErasableWrappers = (value: ts.Expression): ts.Expression => {
    let expr = value;
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertion(expr) ||
      ts.isSatisfiesExpression(expr)
    ) {
      expr = expr.expression;
    }
    return expr;
  };
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if ((lowerer.typeOf(expr).flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0) return null;
  expr = peelErasableWrappers(expr);
  let sawVoid = false;
  while (ts.isVoidExpression(expr)) {
    sawVoid = true;
    expr = peelErasableWrappers(expr.expression);
  }
  return sawVoid ? lowerer.lowerExpr(expr) : lowerer.lowerExpr(node);
}

/** Preserve an explicitly undefined argument's effects, then use its default. */
export function defaultAfterUndefined(value: IrExpr, defaultValue: IrExpr): IrExpr {
  if (isSafeToDiscard(value)) return defaultValue;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc: value.loc }],
    result: defaultValue,
    type: defaultValue.type,
    loc: value.loc,
  };
}

/** Convert an omitted or supplied string-search value after preserving its effects. */
export function lowerStringSearchArgument(lowerer: Lowerer, node: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  const absent = strLit("undefined", loc);
  if (!node) return absent;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, absent);
  return coerceStringSearchValue(lowerer, lowerer.lowerExpr(node), node, loc);
}

/** Convert a lowered string-search value while preserving unit-value effects. */
export function coerceStringSearchValue(lowerer: Lowerer, value: IrExpr, node: ts.Expression, loc: SrcLoc): IrExpr {
  if (isUnitType(value.type)) {
    return defaultAfterUndefined(value, strLit(value.type.kind === "nullT" ? "null" : "undefined", loc));
  }
  return lowerer.ensureString(value, node);
}

/** Lower an optional argument, applying its default only to the undefined arm. */
export function lowerOptionalArgument(
  lowerer: Lowerer,
  node: ts.Expression,
  expected: IrType,
  defaultValue: IrExpr,
): IrExpr {
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, defaultValue);
  const value = lowerer.lowerExpr(node);
  if (value.type.kind === "union") {
    const def = lowerer.unions.get(value.type.unionId);
    if (
      def?.arms.length === 2 &&
      def.arms.some((arm) => arm.kind === "undefinedT") &&
      def.arms.some((arm) => typeEquals(arm, expected))
    ) {
      return { kind: "nullish", left: value, right: defaultValue, type: expected, loc: value.loc };
    }
  }
  return lowerer.coerceInto(node, value, expected);
}

/** Complete an omitted or statically undefined position without dropping argument effects. */
export function lowerPositionArgument(lowerer: Lowerer, node: ts.Expression | undefined, defaultValue: IrExpr): IrExpr {
  if (!node) return defaultValue;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, defaultValue);
  const value = lowerer.lowerExpr(node);
  if (isUnitType(value.type) || value.type.kind === "void") {
    return defaultAfterUndefined(value, value.type.kind === "nullT" ? numLit(0, value.loc) : defaultValue);
  }
  return value;
}

/** Convert a stabilized position after the method has evaluated its arguments. */
export function positionNumber(
  lowerer: Lowerer,
  value: IrExpr,
  defaultValue: IrExpr,
  node: ts.Expression,
  subject: string,
): IrExpr {
  const loc = value.loc;
  switch (value.type.kind) {
    case "f64": return value;
    case "string": return { kind: "libCall", fn: "num.fromString", args: [value], type: F64, loc };
    case "bool": return { kind: "ternary", cond: value, then: numLit(1, loc), else_: numLit(0, loc), type: F64, loc };
    case "nullT": return numLit(0, loc);
    case "undefinedT": return defaultValue;
    case "jsval": return { kind: "jsExit", value, type: F64, loc };
    case "union": {
      const unionId = value.type.unionId;
      const arms = lowerer.unions.get(unionId)!.arms;
      let result: IrExpr = defaultValue;
      for (let tag = arms.length - 1; tag >= 0; tag--) {
        const narrowed: IrExpr = { kind: "unionNarrow", unionId, tag, value, type: arms[tag]!, loc };
        const converted = positionNumber(lowerer, narrowed, defaultValue, node, subject);
        result = tag === arms.length - 1 ? converted : {
          kind: "ternary",
          cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
          then: converted, else_: result, type: F64, loc,
        };
      }
      return result;
    }
    case "dyn": return {
      kind: "ternary",
      cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
      then: defaultValue,
      else_: { kind: "libCall", fn: "dyn.toNumberCoerce", args: [value], type: F64, loc },
      type: F64, loc,
    };
    default: return lowerer.noLowering(`${subject} of '${lowerer.fmt(value.type)}' values`, node);
  }
}
