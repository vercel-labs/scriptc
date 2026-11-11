import * as ts from "../ts7/adapter.js";
import { withoutParenthesesAssertionsSatisfies } from "../outer-expressions.js";
import type { IrExpr, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { BOOL, F64, isUnitType, STRING, typeEquals } from "../../ir/ir.js";
import { nodeThrowExpr, numLit, strLit, varRef } from "../../ir/build.js";
import type { Lowerer } from "./lowerer.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";

/** Lower an expression whose checker type is statically `undefined`/`void`. */
export function lowerStaticallyUndefinedArgument(
  lowerer: Lowerer,
  node: ts.Expression,
): IrExpr | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if ((lowerer.typeOf(expr).flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0)
    return null;
  // The checker typed the argument `undefined` from a narrowing that a call
  // may have undone (`s.slice(done ? start : undefined)` with `start`
  // assigned by a callback): the argument carries the stored value.
  if (lowerer.narrowing.restoredNothingRead(expr) !== null) return null;
  // A caller may already have evaluated the entire argument (including a
  // void operand) before receiver coercion. Do not evaluate it again.
  const stabilized = lowerer.chainRecvByNode.get(node);
  if (stabilized) return stabilized;
  expr = withoutParenthesesAssertionsSatisfies(expr);
  let sawVoid = false;
  while (ts.isVoidExpression(expr)) {
    sawVoid = true;
    expr = withoutParenthesesAssertionsSatisfies(expr.expression);
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
export function lowerStringSearchArgument(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  loc: SrcLoc,
): IrExpr {
  const absent = strLit("undefined", loc);
  if (!node) return absent;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, absent);
  return coerceStringSearchValue(lowerer, lowerer.lowerExpr(node), node, loc);
}

/** Convert a lowered string-search value while preserving unit-value effects. */
export function coerceStringSearchValue(
  lowerer: Lowerer,
  value: IrExpr,
  node: ts.Expression,
  loc: SrcLoc,
): IrExpr {
  if (isUnitType(value.type)) {
    return defaultAfterUndefined(
      value,
      strLit(value.type.kind === "nullT" ? "null" : "undefined", loc),
    );
  }
  // ToString(symbol) throws (only String() answers "Symbol(desc)"); string
  // searches convert their needle with ToString, so the search throws.
  if (value.type.kind === "symbol") return throwAfter(value, SYMBOL_TO_STRING, STRING, loc);
  return lowerer.ensureString(value, node);
}

const SYMBOL_TO_STRING = "Cannot convert a Symbol value to a string";
const SYMBOL_TO_NUMBER = "Cannot convert a Symbol value to a number";

/** `value`, then Node's TypeError: the value's effects happen and the
 * conversion that follows it throws. `type` is the throwing expression's
 * type, so the enclosing lowering keeps its expected shape. */
export function throwAfter(value: IrExpr, message: string, type: IrType, loc: SrcLoc): IrExpr {
  const thrown = nodeThrowExpr(1, "", message, type, loc);
  if (isSafeToDiscard(value)) return thrown;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: thrown,
    type,
    loc,
  };
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
    const unionId = value.type.unionId;
    const def = lowerer.unions.get(unionId);
    // The union carries undefined (an optional slot) and one present arm of
    // the expected type. An iterated tuple's element type models absence as
    // both null and undefined, and that extra arm cannot hold a present
    // value, so the present arm is the only other one that does. A union
    // whose present arms are anything else keeps the strict conversion
    // below.
    const undefinedTag = def?.arms.findIndex((arm) => arm.kind === "undefinedT") ?? -1;
    const rest = def?.arms.filter((arm) => !isUnitType(arm)) ?? [];
    if (
      def !== undefined &&
      undefinedTag >= 0 &&
      rest.length === 1 &&
      typeEquals(rest[0]!, expected)
    ) {
      const nullTag = def.arms.findIndex((arm) => arm.kind === "nullT");
      if (nullTag < 0) {
        return {
          kind: "nullish",
          left: value,
          right: defaultValue,
          type: expected,
          loc: value.loc,
        };
      }
      // Only undefined is an omitted slot: a supplied null is a value, and
      // Node converts it like any other (ToString(null) is "null",
      // ToNumber(null) is 0). The null arm of an iterated tuple's element
      // type holds nothing, so the conversion is what Node would do anyway.
      const nullValue =
        expected.kind === "string"
          ? strLit("null", value.loc)
          : expected.kind === "f64"
            ? numLit(0, value.loc)
            : null;
      if (nullValue !== null) {
        const presentTag = def.arms.findIndex((arm) => typeEquals(arm, expected))!;
        // Both readings inspect the value's tag, so evaluate it once.
        const stmts: IrStmt[] = [];
        let subject = value;
        if (value.kind !== "varRef") {
          const local = lowerer.declareHiddenLocal("%optionalSlot", value.type);
          stmts.push({ kind: "varDecl", localId: local.id, init: value, loc: value.loc });
          subject = varRef(local.id, value.type, value.loc);
        }
        const supplied: IrExpr = {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId,
            tag: nullTag,
            negated: false,
            value: subject,
            type: BOOL,
            loc: value.loc,
          },
          then: nullValue,
          else_: {
            kind: "unionNarrow",
            unionId,
            tag: presentTag,
            value: subject,
            type: expected,
            loc: value.loc,
          },
          type: expected,
          loc: value.loc,
        };
        const result: IrExpr = {
          kind: "ternary",
          cond: {
            kind: "unionIsTag",
            unionId,
            tag: undefinedTag,
            negated: false,
            value: subject,
            type: BOOL,
            loc: value.loc,
          },
          then: defaultValue,
          else_: supplied,
          type: expected,
          loc: value.loc,
        };
        return stmts.length === 0
          ? result
          : { kind: "seqExpr", stmts, result, type: expected, loc: value.loc };
      }
    }
  }
  return lowerer.coerceInto(node, value, expected);
}

/** Complete an omitted or statically undefined position without dropping argument effects. */
export function lowerPositionArgument(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  defaultValue: IrExpr,
): IrExpr {
  if (!node) return defaultValue;
  const undefinedArg = lowerStaticallyUndefinedArgument(lowerer, node);
  if (undefinedArg) return defaultAfterUndefined(undefinedArg, defaultValue);
  const value = lowerer.lowerExpr(node);
  if (isUnitType(value.type) || value.type.kind === "void") {
    return defaultAfterUndefined(
      value,
      value.type.kind === "nullT" ? numLit(0, value.loc) : defaultValue,
    );
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
    case "f64":
      return value;
    case "string":
      return { kind: "libCall", fn: "num.fromString", args: [value], type: F64, loc };
    case "bool":
      return {
        kind: "ternary",
        cond: value,
        then: numLit(1, loc),
        else_: numLit(0, loc),
        type: F64,
        loc,
      };
    case "nullT":
      return numLit(0, loc);
    case "undefinedT":
      return defaultValue;
    // ToNumber/ToIntegerOrInfinity(symbol) throws; it is not a number.
    case "symbol":
      return throwAfter(value, SYMBOL_TO_NUMBER, F64, loc);
    case "union": {
      const unionId = value.type.unionId;
      const arms = lowerer.unions.get(unionId)!.arms;
      let result: IrExpr = defaultValue;
      for (let tag = arms.length - 1; tag >= 0; tag--) {
        const narrowed: IrExpr = {
          kind: "unionNarrow",
          unionId,
          tag,
          value,
          type: arms[tag]!,
          loc,
        };
        const converted = positionNumber(lowerer, narrowed, defaultValue, node, subject);
        result =
          tag === arms.length - 1
            ? converted
            : {
                kind: "ternary",
                cond: { kind: "unionIsTag", unionId, tag, value, negated: false, type: BOOL, loc },
                then: converted,
                else_: result,
                type: F64,
                loc,
              };
      }
      return result;
    }
    case "dyn":
      return {
        kind: "ternary",
        cond: { kind: "dynTest", test: "undefined", value, type: BOOL, loc },
        then: defaultValue,
        else_: { kind: "libCall", fn: "dyn.toNumberCoerce", args: [value], type: F64, loc },
        type: F64,
        loc,
      };
    default:
      lowerer.noLowering(`${subject} of '${lowerer.fmt(value.type)}' values`, node);
  }
}
