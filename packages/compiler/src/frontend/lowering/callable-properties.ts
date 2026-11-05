/* Function objects carry own properties. `Object.assign(fn, {...})`,
 * `fn.k = v`, a chalk-style builder and a TypeScript function merged with a
 * namespace all put data properties ON the function, and Node gives one
 * answer for each: the result IS the function, a write through any alias is
 * visible through every other, `Object.keys(fn)` lists the enumerable own
 * keys, `typeof` stays "function", inspect prints `[Function: f] { k: v }`,
 * and the value stays callable.
 *
 * One representation: the closure's own-property table (`ScrClosure.props`,
 * `scr_dyn_fn_table` in scr_json.c), which the dynamic tier already uses and
 * which is exact for identity, aliasing, key order and inspect. A typed
 * callable reaches it through the identity-preserving dynamic box — `dynFrom`
 * of the closure shares it — and then the SAME keyed operations the `any`
 * view of the same value emits (dynKeyGet/dynKeySet/dyn.assignAll). A read
 * checks the value back into the member's declared type with `dynCheck`, so a
 * JavaScript-written value of the wrong shape throws the catchable TypeError
 * every checked cast throws instead of being misread.
 *
 * The helpers here decide WHEN a receiver is such a callable ("call
 * signatures, no construct signature, not a class, lowered as a func") and
 * which member names address its table (`length`, `name`, `caller`,
 * `arguments`, `prototype` and the Function.prototype members belong to the
 * function protocol, not to the table's user data). They never change a
 * call: a call reads the member through the table and calls the closure it
 * finds.
 *
 * The members a function carries because a NAMESPACE of the same name is
 * merged into it are the one family still stored elsewhere: the namespace
 * lowering's flattened module globals own those names, so their reads,
 * writes and calls resolve by member symbol as before and only
 * `Object.keys`/inspect of such a function do not list them. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { DYN, type IrExpr, type IrType } from "../../ir/ir.js";
import type { FieldTarget } from "./lower-exprs.js";
import { locOf } from "../program.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** The function protocol's own members: never table data, in reads, writes,
 * `in`, `delete` or enumeration. A callable's data members cannot shadow
 * them (JavaScript gives the function object's built-in slot precedence for
 * the non-configurable ones). */
const FUNCTION_PROTOCOL_MEMBERS = new Set([
  "apply",
  "bind",
  "call",
  "toString",
  "constructor",
  "__proto__",
  "length",
  "name",
  "caller",
  "arguments",
  "prototype",
]);

/** Whether `name` is a member a typed callable keeps in its own-property
 * table rather than answering through the function protocol. */
export function isCallableOwnMemberName(name: string): boolean {
  return !FUNCTION_PROTOCOL_MEMBERS.has(name) && !name.startsWith("__");
}

/** The checker's view of `receiver`: a callable value with no construct
 * signature, not a class, that lowers to a closure (`func` IR type). DYN
 * receivers (recursive, `this`-typed and symbol-keyed callable objects) have
 * their own live-table paths and answer false. */
export function isCallableValue(lowerer: Lowerer, receiver: ts.Expression): boolean {
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(receiver));
  if (lowerer.checker.getCallSignatures(type).length === 0) return false;
  if (lowerer.checker.getConstructSignatures(type).length > 0) return false;
  const symbol = type.getSymbol();
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0) return false;
  if (lowerer.mapTypeOf(type)?.kind !== "func") return false;
  // A stdlib function object (`Number`, `String`, `Object`) is a native
  // value with its own lowering paths: boxing it to read a member would
  // pull a dynamic builtin unit into typed-only code, and its members
  // (`MAX_SAFE_INTEGER`, `fromCodePoint`) are answered statically.
  return stdlibGlobalNameOf(lowerer, receiver) === null;
}

/** The identity-preserving box of a callable value: `dynFrom` shares the
 * closure's property table, so a write through the box and a read through
 * the closure (or the reverse) observe one object. Null when the func cannot
 * box (its prototype back-edge needs a dyn form). */
export function callableBox(lowerer: Lowerer, value: IrExpr): IrExpr | null {
  if (value.type.kind === "dyn") return value;
  if (value.type.kind !== "func" || !lowerer.dynConvertible(value.type)) return null;
  const boxed = lowerer.coerceToExpected(value, DYN);
  return boxed.type.kind === "dyn" ? boxed : null;
}

/** `receiver.name` on a typed callable: the member's declared type, checked
 * after the table read. Null when the access is not a table member (the
 * function protocol, a symbol key, an accessor, a receiver that is not a
 * typed callable) or when the declared type has no checked conversion. */
export function callableMemberFieldTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  receiverIr: IrType,
): FieldTarget | null {
  if (access.questionDotToken || !ts.isIdentifier(access.name)) return null;
  const name = access.name.text;
  if (!isCallableOwnMemberName(name)) return null;
  if (receiverIr.kind !== "func") return null;
  // The value must be a typed callable by the same test every other table
  // form uses. A stdlib function object (`Number.MAX_SAFE_INTEGER`,
  // `String.fromCodePoint`) lowers as a closure too, but its members are
  // that object's statics, not table data — declining here before the
  // receiver is lowered also keeps its builtin unit out of a program that
  // only reads the static.
  if (!isCallableValue(lowerer, access.expression)) return null;
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(access.expression));
  const property = lowerer.checker.getPropertyOfType(type, name);
  if (property !== undefined) {
    // An accessor member is not table data; it stays on its own path (and
    // its refusals) rather than reading the accessor's value from the table.
    if (property.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) return null;
    if (ts.symbolName(property).startsWith("__@")) return null;
  } else if (lowerer.checker.getIndexInfosOfType(type).length === 0) {
    return null;
  }
  const fieldType = lowerer.mapTypeOf(lowerer.typeOf(access));
  if (!fieldType || fieldType.kind === "void") return null;
  const boxed = callableBox(lowerer, lowerer.lowerExpr(access.expression));
  if (!boxed) return null;
  return { container: "dynamic", obj: boxed, field: name, fieldType };
}

/** A receiver whose ELEMENT access addresses the closure's own-property
 * table: the same callable test, on the value the caller already lowered.
 * Any key is admitted — the runtime's keyed get/set answers the table first
 * and the function protocol's inherited members when the table misses. */
export function isCallableTableValue(
  lowerer: Lowerer,
  receiver: ts.Expression,
  value: IrExpr,
): boolean {
  return value.type.kind === "func" && isCallableValue(lowerer, receiver);
}

/** `Object.assign(fn, ...sources)` on a typed callable: each source's own
 * enumerable keys land on the closure's table and the expression yields the
 * function (the boxed clone-collapsing identity). This is the operation the
 * `any` view of the same value already emits. */
export function lowerCallableAssign(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.arguments.nodes.length === 0) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  const target = call.arguments.nodes[0]!;
  if (!isCallableValue(lowerer, target)) return null;
  const value = lowerer.lowerExpr(target);
  const boxed = callableBox(lowerer, value);
  if (!boxed) return null;
  const loc = locOf(call);
  return {
    kind: "libCall",
    fn: "dyn.assignAll",
    args: [
      boxed,
      {
        kind: "dynArrLit",
        elems: call.arguments.nodes.slice(1).map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
        type: DYN,
        loc,
      },
    ],
    type: DYN,
    loc,
  };
}

/** `delete fn.k` / `delete fn[k]`: the table entry's removal. */
export function callableDeleteKey(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  if (ts.isPropertyAccessExpression(access)) {
    return isCallableOwnMemberName(access.name.text) && isCallableValue(lowerer, access.expression);
  }
  return isCallableValue(lowerer, access.expression);
}
