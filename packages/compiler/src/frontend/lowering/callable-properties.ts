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
 * `arguments`, `prototype` and `__proto__` belong to the function
 * protocol, not to the table's user data; the members a function inherits —
 * `toString` and the call/apply/bind and Object.prototype names — are table
 * data when the value's type declares them in user code). They never change
 * a call to a plain function: a call whose callee is a table member reads it
 * through the table and calls the closure it finds.
 *
 * An inherited name is shadowable in JS, and a WRITE always makes it table
 * data: `fn.call = f` creates an own data property that the runtime's table
 * read and its call/apply/bind dispatch both see first (scr_json.c,
 * scr_dyn_invoke.c). The write target therefore admits the inherited names
 * unconditionally, while the read target asks for a user declaration (an
 * inherited `fn.call` on a plain function still answers through the
 * protocol lowering it has always had).
 *
 * The members a function carries because a NAMESPACE of the same name is
 * merged into it are table entries too: the merged block writes each
 * exported member onto the function object at the member's source position,
 * and reads, writes, `in` and `delete` go through the same keyed operations
 * (lower-fundule.ts). A namespace that does NOT merge with a function keeps
 * its flattened module globals — those are a different value. */
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

/** The members a function inherits from Function.prototype and
 * Object.prototype. JS lets an own data property shadow every one of them
 * (`fn.toString = ...`, `fn.call = ...`), so a typed callable that declares
 * one keeps its value in the table. `__proto__` is the prototype accessor,
 * never table data. */
const FUNCTION_INHERITED_MEMBERS = new Set([
  "toString",
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

/** Whether `name` may name an own property of a typed callable. The fixed
 * slots and the `__proto__` accessor never can; every other name, an
 * inherited protocol member included, can. */
export function isCallableOwnMemberName(name: string): boolean {
  return !FUNCTION_FIXED_SLOTS.has(name) && name !== "__proto__";
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

/** Whether the value's own type declares `name` as a user member, so a read
 * of it is table data rather than the function protocol. The statically
 * resolved protocol forms (`f.apply(thisArg, tuple)`, which a wrapper lowers
 * to a direct call of the function body) must ask this before they take their
 * shortcut: for such a value the own table entry is the callee, and the
 * general member-call path is the one that reads it. */
export function callableDeclaresMember(
  lowerer: Lowerer,
  receiver: ts.Expression,
  name: string,
): boolean {
  const type = lowerer.checker.getNonNullableType(lowerer.typeOf(receiver));
  const property = lowerer.checker.getPropertyOfType(type, name);
  return property !== undefined && isUserDeclaredMember(lowerer, property);
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
  return callableTarget(lowerer, access, receiverIr, false);
}

/** The WRITE target for `receiver.name = value` on a typed callable. It
 * differs from the read target in one way: an inherited protocol name
 * (`fn.call = f`) is admitted without a user declaration, because the write
 * IS the own property JS creates — the shadow the runtime then reads and
 * dispatches first. */
export function callableMemberWriteTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  receiverIr: IrType,
): FieldTarget | null {
  return callableTarget(lowerer, access, receiverIr, true);
}

function callableTarget(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
  receiverIr: IrType,
  forWrite: boolean,
): FieldTarget | null {
  if (access.questionDotToken || !ts.isIdentifier(access.name)) return null;
  const name = access.name.text;
  if (FUNCTION_FIXED_SLOTS.has(name) || name === "__proto__") return null;
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
  // A READ of an inherited name is a table key only when the value's own
  // type declares it: `fn.toString = () => "x"` shadows the prototype
  // member with an own data property, while a plain read of `fn.toString`
  // is still the protocol. A write creates that own property, so it is
  // admitted either way.
  if (
    !forWrite &&
    FUNCTION_INHERITED_MEMBERS.has(name) &&
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

/** `delete fn.k` / `delete fn[k]`: the table entry's removal. A delete
 * through a checked-dynamic assertion (`delete (fn as any).k`) counts too:
 * the assertion lowers to the operand itself, so the statement deletes from
 * the same closure the operand names. */
export function callableDeleteKey(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  if (ts.isPropertyAccessExpression(access) && !isCallableOwnMemberName(access.name.text))
    return false;
  return (
    isCallableValue(lowerer, access.expression) || isCallableDynView(lowerer, access.expression)
  );
}

/** An assertion of the operand to a checked-dynamic view (`fn as any`,
 * `fn as unknown`) whose operand is a typed callable. The assertion is
 * identity-preserving for a native value, so the delete addresses the
 * closure's table — the same receiver the unasserted form does. */
function isCallableDynView(lowerer: Lowerer, receiver: ts.Expression): boolean {
  let e = receiver;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isAsExpression(e) && !ts.isTypeAssertion(e)) return false;
  const assertedType = lowerer.checker.getTypeFromTypeNode(e.type);
  const dyn =
    (assertedType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
    lowerer.mapTypeOf(assertedType)?.kind === "dyn";
  if (!dyn) return false;
  return isCallableValue(lowerer, e.expression) || isCallableDynView(lowerer, e.expression);
}
