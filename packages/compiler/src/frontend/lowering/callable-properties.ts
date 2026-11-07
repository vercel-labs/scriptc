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
 * `arguments`, `prototype`, the runtime's fenced prototype members and
 * `__proto__` belong to the function protocol, not to the table's user
 * data; `toString` is table data when the value's type declares it). They
 * never change a call to a plain function: a call whose callee is a table
 * member reads it through the table and calls the closure it finds.
 *
 * Two families stay off the table. A member the runtime's function-table
 * property fence refuses (call/apply/bind and the Object.prototype
 * members) keeps its existing refusal rather than becoming a table entry.
 * The members a function carries because a NAMESPACE of the same name is
 * merged into it are still stored elsewhere: the namespace
 * lowering's flattened module globals own those names, so their reads,
 * writes and calls resolve by member symbol as before and only
 * `Object.keys`/inspect of such a function do not list them. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { DYN, type IrExpr, type IrType } from "../../ir/ir.js";
import type { FieldTarget } from "./lower-exprs.js";
import { locOf } from "../program.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** The function object's non-configurable own slots plus the poisoned
 * `caller`/`arguments` pair: no data property of those names can exist on a
 * function, so they are never table data in reads, writes, `in`, `delete` or
 * enumeration. */
const FUNCTION_FIXED_SLOTS = new Set(["length", "name", "prototype", "caller", "arguments"]);

/** The members a function inherits from the native call/apply/bind and
 * Object.prototype lowerings. The runtime's function-table property fence
 * (`scr_dyn_fn_property_fence`, scr_json.c) refuses every write to them,
 * because a typed call site that does not declare the name answers through
 * that builtin rather than the table; a callable interface that declares one
 * therefore keeps its existing refusal instead of becoming a table entry.
 * `__proto__` is the prototype accessor, never table data either. */
const FUNCTION_RESERVED_MEMBERS = new Set([
  "apply",
  "bind",
  "call",
  "valueOf",
  "toLocaleString",
  "hasOwnProperty",
  "propertyIsEnumerable",
  "isPrototypeOf",
  "constructor",
]);

/** The one inherited member a function may shadow with an own data property
 * the table accepts: `Function.prototype.toString` is not in the fence, so
 * `fn.toString = () => "x"` is an ordinary own property in Node and here.
 * It is table data only when the value's TYPE declares it in user code;
 * otherwise the name answers through the protocol. */
const FUNCTION_SHADOWABLE_MEMBERS = new Set(["toString"]);

/** Whether `name` is a member a typed callable keeps in its own-property
 * table rather than answering through the function protocol. */
export function isCallableOwnMemberName(name: string): boolean {
  return (
    !FUNCTION_FIXED_SLOTS.has(name) &&
    !FUNCTION_RESERVED_MEMBERS.has(name) &&
    !FUNCTION_SHADOWABLE_MEMBERS.has(name) &&
    name !== "__proto__"
  );
}

/** Whether the value's type declares `property` itself (a user interface or
 * intersection part) rather than inheriting it from a standard library
 * interface — the test that makes an inherited member name a table key. */
function isUserDeclaredMember(lowerer: Lowerer, property: ts.Symbol): boolean {
  return property.declarations.some((d) => !lowerer.isStdlibFile(ts.getSourceFileOfNode(d)));
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
  if (FUNCTION_FIXED_SLOTS.has(name) || FUNCTION_RESERVED_MEMBERS.has(name) || name === "__proto__")
    return null;
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
  // An inherited name is a table key only when the value's own type declares
  // it: `fn.toString = () => "x"` shadows the prototype member with an own
  // data property, while a plain read of `fn.toString` is still the protocol.
  if (
    FUNCTION_SHADOWABLE_MEMBERS.has(name) &&
    (property === undefined || !isUserDeclaredMember(lowerer, property))
  )
    return null;
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
