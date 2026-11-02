/** Node's TypeErrors for an operation that needs an OBJECT and receives a
 * primitive — the `in` operator's ToObject, `new`'s IsConstructor,
 * `delete`'s ToObject, and a member read's RequireObjectCoercible.
 * JavaScript admits every one of these on a primitive (and the relaxed
 * JavaScript diagnostics admit the source), so the code must run and throw
 * exactly what V8 throws, not a lowering fence.
 *
 * Every message is built from the operand's own spelling, which is why the
 * text is a runtime expression here rather than the literal
 * `nodeThrowExpr` takes. */
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  isUnitType,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, strLit } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { heldEnvValueType } from "./builtins/environment.js";
import {
  erasedDeletePlan,
  lowerDeleteKey,
  lowerRecordDeleteExpr,
} from "./expressions/erased-delete.js";
import { lowerEnvironmentKey } from "./expressions/element-access.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";
import { isStrictCode } from "./strict-mode.js";

/** IR types whose JS value is a primitive: no own or inherited properties,
 * so a property read, `in`, or `delete` coerces it — and `in` throws.
 * `void` is the return position of a call, whose value at run time is
 * undefined. */
export function isPrimitiveValueType(t: IrType): boolean {
  switch (t.kind) {
    case "nullT":
    case "undefinedT":
    case "void":
    case "bool":
    case "f64":
    case "bigint":
    case "string":
    case "symbol":
      return true;
    default:
      return false;
  }
}

/** The operand's spelling in a can't-coerce TypeError: units are literal,
 * and every other primitive renders exactly as String() renders it (the
 * object protocol never runs for a primitive, so the String constructor
 * lowers to the same text V8 writes). */
export function primitiveText(lowerer: Lowerer, value: IrExpr, loc: SrcLoc): IrExpr {
  if (isUnitType(value.type)) {
    return strLit(value.type.kind === "nullT" ? "null" : "undefined", loc);
  }
  return {
    kind: "libCall",
    fn: "dyn.stringConstructor",
    args: [lowerer.coerceToExpected(value, DYN)],
    type: STRING,
    loc,
  };
}

/** An always-throwing Node TypeError whose message is computed at run time.
 * `type` is the replaced expression's own type (never materialized). */
export function throwTypeError(message: IrExpr, type: IrType, loc: SrcLoc): IrExpr {
  return {
    kind: "libCall",
    fn: "error.nodeThrow",
    args: [numLit(1, loc), strLit("", loc), message],
    type,
    loc,
  };
}

/** `Cannot use 'in' operator to search for '<key>' in <String(recv)>` — the
 * `in` operator's ToObject refusal, also spelled by Reflect.has's
 * non-object target check (which uses its own fixed message). */
export function inOperatorTypeError(
  lowerer: Lowerer,
  key: string,
  recv: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  return throwTypeError(
    {
      kind: "strConcat",
      left: strLit(`Cannot use 'in' operator to search for '${key}' in `, loc),
      right: primitiveText(lowerer, recv, loc),
      type: STRING,
      loc,
    },
    type,
    loc,
  );
}

/** `delete`'s ToObject refusal: Node names neither the property nor the
 * receiver here (`delete (null).x` and `delete (null)[k]` both throw it). */
export function deleteToObjectTypeError(type: IrType, loc: SrcLoc): IrExpr {
  return throwTypeError(strLit("Cannot convert undefined or null to object", loc), type, loc);
}

/** `null`/`undefined` when the expression IS one of them by construction —
 * the `null` keyword, `void <expr>`, or the global `undefined` (the checker
 * confirms the name still denotes the unit, since JavaScript may shadow it)
 * — else null. Used where a member read happens before the receiver is
 * lowered, so the test cannot disturb the lowering that follows. A binding
 * or a property does NOT qualify even when the checker types it as a unit:
 * a JavaScript property keeps its initializer's type through a later
 * assignment, so its value has to answer, and the runtime read already
 * throws the same TypeError in the same order. */
export function nullishLiteral(lowerer: Lowerer, node: ts.Expression): "null" | "undefined" | null {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isVoidExpression(expr)) return "undefined";
  if (!ts.isIdentifier(expr) || expr.text !== "undefined") return null;
  const flags = lowerer.typeOf(expr).flags;
  return flags & ts.TypeFlags.Undefined ? "undefined" : null;
}

/** True when the CHECKER types an expression as a primitive — a unit or any
 * other primitive, or a union of them — and not as `any`/`unknown`, whose
 * value the lowering cannot know. `new` uses it to choose the runtime
 * primitive check for a callee that lowers to a dynamic slot (a JavaScript
 * `const n = null` binding): an `any` callee keeps the runtime's own
 * refusal, so the typed programs pay nothing for this branch. */
export function staticallyPrimitive(lowerer: Lowerer, node: ts.Expression): boolean {
  const { flags } = lowerer.typeOf(node);
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  // A union answers through its arms, which the caller's IR types cover.
  return (
    (flags &
      (ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.ESSymbolLike)) !==
    0
  );
}

/** `Cannot read properties of <unit> (reading '<name>')` — the member read
 * a nullish receiver refuses, also what a call on such a member throws
 * before its arguments evaluate. */
export function nullishReadTypeError(
  unit: "null" | "undefined",
  name: string,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  return throwTypeError(
    strLit(`Cannot read properties of ${unit} (reading '${name}')`, loc),
    type,
    loc,
  );
}

/** The text every builtin identity token carries: the identifier chokepoint
 * and the JavaScript destructuring rule intern `[builtin <name>]`
 * (identifiers.ts, property-access.ts, global-values.ts, lower-stmts.ts). */
const BUILTIN_TOKEN_PREFIX = "[builtin ";
const BUILTIN_TOKEN_SUFFIX = "]";

/** A builtin identity token, which is NOT a primitive the program can
 * observe. The identifier chokepoint represents a JavaScript source's
 * unsupported builtin value (`import { AsyncResource } from
 * "node:async_hooks"`) as an IR string whose text Node never produces, so
 * identity flows (`===`, Set membership) agree between spellings. The
 * object-coercion lowerings throw Node's TypeError for a primitive and
 * spell it from the value, which for a token would report the carrier as if
 * the program could see it ("AsyncResource is not a constructor" for a
 * class Node constructs), so those branches leave the site to the
 * reference's own fence instead.
 *
 * A token is recognized by its interned TEXT, not by its type alone: a
 * program's own string casts to `any` as readily as an unsupported builtin
 * export does, and `new ("hello" as any)()` is a Node TypeError to run, not
 * a lowering fence. The checker test stays as a second condition, so a
 * string the checker types as a string keeps its Node answer even when it
 * spells a token. */
export function isBuiltinIdentityToken(
  lowerer: Lowerer,
  node: ts.Expression,
  value: IrExpr,
): boolean {
  if (value.kind !== "strLit") return false;
  if (!value.value.startsWith(BUILTIN_TOKEN_PREFIX)) return false;
  if (!value.value.endsWith(BUILTIN_TOKEN_SUFFIX)) return false;
  function stringLike(t: ts.Type): boolean {
    if ((t.flags & ts.TypeFlags.StringLike) !== 0) return true;
    return t.isUnionType() && ts.constituentTypes(t).every(stringLike);
  }
  return !stringLike(lowerer.typeOf(node));
}

/** The statements that evaluate `expr` for its effects alone. A value the
 * IR cannot spell (a unit — JavaScript's null/undefined has no standalone
 * runtime value, so a bare unit literal fails validation) contributes only
 * the statements its sequence kept, and a plain unit literal none at all. */
export function effectStmts(expr: IrExpr, loc: SrcLoc): IrStmt[] {
  if (isSafeToDiscard(expr)) return [];
  if (expr.kind === "seqExpr") return [...expr.stmts, ...effectStmts(expr.result, loc)];
  return [{ kind: "exprStmt", expr, loc }];
}

/** `thrown`, preceded by the evaluation of `values` in order — the shape of
 * every object-coercion refusal whose operands still have to run before the
 * throw (`(recordedKey() in nullishReceiver())`). */
export function throwAfterEach(values: readonly IrExpr[], thrown: IrExpr, loc: SrcLoc): IrExpr {
  const stmts = values.flatMap((value) => effectStmts(value, loc));
  return stmts.length === 0
    ? thrown
    : { kind: "seqExpr", stmts, result: thrown, type: thrown.type, loc };
}

/** Whether a member `delete` with this receiver deletes from the environment:
 * the ambient `process.env` object itself or a value HELD from it
 * (environment.ts), whose member accesses alias the live table. */
function isEnvironmentReceiver(lowerer: Lowerer, node: ts.Expression): boolean {
  return lowerer.isProcessEnv(node) || heldEnvValueType(lowerer, node) !== null;
}

/** Expression-position `delete` of an environment member — `delete
 * process.env.X`, a bracket key, or a member through a held or asserted view
 * of the environment. Node's environment is one live object, so the delete
 * unsets the variable and answers `true`: every environment entry is
 * configurable, sloppy or strict. Lowering the receiver as the value its type
 * gives would delete the member from a SNAPSHOT record instead, answering
 * `true` while the actual variable stayed set. The delete therefore takes
 * the same unset the statement form does (lower-stmts.ts), and the receiver
 * — the ambient object or a binding read, neither of which runs program code
 * — is not evaluated at all. */
function lowerEnvironmentDeleteExpr(
  lowerer: Lowerer,
  expr: ts.DeleteExpression,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): IrExpr {
  const loc = locOf(expr);
  const key = ts.isPropertyAccessExpression(target)
    ? lowerDeleteKey(lowerer, target)
    : lowerEnvironmentKey(lowerer, target.argumentExpression);
  if (key.type.kind !== "string")
    lowerer.unsupported(
      "SC1090",
      expr,
      `'delete' of environment keys of '${lowerer.fmt(key.type)}' values (env keys are strings; a Symbol key removes nothing)`,
    );
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "process.envUnset", args: [key], type: VOID, loc },
        loc,
      },
    ],
    result: { kind: "boolLit", value: true, type: BOOL, loc },
    type: BOOL,
    loc,
  };
}

/** Expression-position `delete` (`const ok = delete x.y`). Every receiver but
 * a primitive keeps the statement-position-only fence. */
export function lowerDeleteExpression(lowerer: Lowerer, expr: ts.DeleteExpression): IrExpr {
  let target: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    // The same rule as the statement form (erased-delete.ts): a delete
    // through a chain of type assertions addresses the operand, in place.
    const erased = erasedDeletePlan(lowerer, target);
    if (erased !== null) {
      if ("refuse" in erased) lowerer.unsupported("SC1090", expr, erased.refuse);
      if (isEnvironmentReceiver(lowerer, erased.operand))
        return lowerEnvironmentDeleteExpr(lowerer, expr, target);
      return lowerRecordDeleteExpr(lowerer, expr, target, lowerer.lowerExpr(erased.operand));
    }
    // The environment is one live object in Node: the delete unsets the
    // variable rather than removing a member from a snapshot of it.
    if (isEnvironmentReceiver(lowerer, target.expression))
      return lowerEnvironmentDeleteExpr(lowerer, expr, target);
    const obj = lowerer.lowerExpr(target.expression);
    if (obj.type.kind === "record") return lowerRecordDeleteExpr(lowerer, expr, target, obj);
    if (
      isPrimitiveValueType(obj.type) &&
      !isBuiltinIdentityToken(lowerer, target.expression, obj)
    ) {
      return lowerPrimitiveBaseDelete(lowerer, expr, target, obj, BOOL);
    }
  }
  lowerer.unsupported("SC1090", expr, "delete expressions");
}

/** `delete` on a primitive base, whose ToObject step gives the answer. The
 * base evaluates first, then the key:
 *
 * - a nullish base throws Node's ToObject TypeError before the key's
 *   ToPropertyKey, so the key runs without converting (and, through `?.`,
 *   the chain short-circuits instead: the answer is `true` and the key
 *   never runs);
 * - any other primitive deletes from the ToObject wrapper. A String
 *   wrapper carries its indexes and `length` as non-configurable own
 *   properties, so deleting one answers `false` in sloppy code and throws
 *   the TypeError in strict code, while every other primitive's wrapper
 *   owns nothing. The runtime does the ToPropertyKey, which preserves a
 *   Symbol key.
 *
 * `resultType` is the replaced expression's own type (never materialized). */
export function lowerPrimitiveBaseDelete(
  lowerer: Lowerer,
  expr: ts.DeleteExpression,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  obj: IrExpr,
  resultType: IrType,
): IrExpr {
  const loc = locOf(expr);
  const unit = isUnitType(obj.type);
  if (unit && target.questionDotToken) {
    // `base?.[key]` on a nullish base: the chain is undefined, the delete
    // answers true, and the key does not evaluate.
    return throwAfterEach([obj], { kind: "boolLit", value: true, type: BOOL, loc }, loc);
  }
  const key = ts.isPropertyAccessExpression(target)
    ? (strLit(target.name.text, loc) as IrExpr)
    : lowerer.lowerExpr(target.argumentExpression);
  if (unit) return throwAfterEach([obj, key], deleteToObjectTypeError(resultType, loc), loc);
  return {
    kind: "libCall",
    fn: "dyn.primitiveDelete",
    args: [
      lowerer.coerceToExpected(obj, DYN),
      lowerer.coerceToExpected(key, DYN),
      { kind: "boolLit", value: isStrictCode(expr), type: BOOL, loc },
    ],
    type: BOOL,
    loc,
  };
}
