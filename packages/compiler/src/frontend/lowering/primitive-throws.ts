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
  isUnitType,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, strLit } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { isSafeToDiscard } from "./expressions/evaluation-safety.js";

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

/** Expression-position `delete` (`const ok = delete x.y`): the value is
 * `true` — or Node's ToObject TypeError for a nullish base — which is
 * exactly the answer for a primitive receiver. Every other receiver keeps
 * the statement-position-only fence. */
export function lowerDeleteExpression(lowerer: Lowerer, expr: ts.DeleteExpression): IrExpr {
  const loc = locOf(expr);
  let target: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    const obj = lowerer.lowerExpr(target.expression);
    if (isPrimitiveValueType(obj.type)) {
      const unit = isUnitType(obj.type);
      const key = ts.isPropertyAccessExpression(target)
        ? null
        : unit
          ? // ToObject throws before ToPropertyKey: the key runs, nothing
            // converts it.
            lowerer.lowerExpr(target.argumentExpression)
          : // A non-nullish primitive's wrapper does reach ToPropertyKey, so
            // an object key's toString runs (and its throw propagates); a
            // primitive key converts without user code.
            primitiveBaseKey(lowerer, target.argumentExpression, loc);
      const result: IrExpr = unit
        ? deleteToObjectTypeError(BOOL, loc)
        : { kind: "boolLit", value: true, type: BOOL, loc };
      return throwAfterEach(key === null ? [obj] : [obj, key], result, loc);
    }
  }
  lowerer.unsupported("SC1090", expr, "delete expressions");
}

/** ToPropertyKey of a key on a NON-nullish primitive base: a dyn key runs
 * its own conversion, a primitive key converts without user code, and any
 * other representation (a record, a class instance lowered natively) keeps
 * a written refusal rather than dropping its conversion. */
function primitiveBaseKey(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const raw = lowerer.lowerExpr(node);
  switch (raw.type.kind) {
    case "string":
    case "f64":
    case "bool":
    case "bigint":
    case "symbol":
      return raw;
    case "dyn":
      return { kind: "libCall", fn: "dyn.toStringCoerce", args: [raw], type: STRING, loc };
    default:
      return lowerer.unsupported(
        "SC1090",
        node,
        `'delete' with a '${lowerer.fmt(raw.type)}' key on a primitive base`,
      );
  }
}
