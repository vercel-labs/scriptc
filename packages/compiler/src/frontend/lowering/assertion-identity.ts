/* Type assertions of the global object.
 *
 * `globalThis as { [KEY]?: State }` is the process-global state idiom: a
 * module asserts the global object to a record type and reads and writes
 * its members, and every other module that asserts it sees the same
 * members. Node evaluates the assertion to the global object itself.
 *
 * The global object is a checked-dynamic value, and a checked-dynamic value
 * asserted to a record or array type takes the checked extraction
 * (dynCheck), which builds a new native value. For the global object that
 * copy is always wrong: a write through it never reached the global object,
 * and a view bound before another module's write never saw it. So an
 * assertion of the global object keeps the checked-dynamic value itself: a
 * view whose member reads and writes go to the global object, and bindings
 * of it hold that object.
 *
 * Other checked-dynamic operands keep the checked extraction: a native value
 * held as `unknown` unwraps by identity there, and a checked-dynamic tree is
 * copied at the documented checked-value boundary.
 */
import * as ts from "../ts7/adapter.js";
import type { IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";
import { stdlibGlobalNameOf } from "./surfaces.js";

/** A target whose checked extraction builds a new mutable value. */
export function extractionCopiesReference(lowerer: Lowerer, type: IrType): boolean {
  const seen = new Set<string>();
  const copies = (t: IrType): boolean => {
    if (t.kind === "record" || t.kind === "array") return true;
    if (t.kind !== "union" || seen.has(t.unionId)) return false;
    seen.add(t.unionId);
    return lowerer.unions.get(t.unionId)?.arms.some(copies) ?? false;
  };
  return copies(type);
}

/** The asserted expression without parentheses, `!` and nested
 * assertions (`globalThis as unknown as T`). */
function assertedSource(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertion(e) ||
    ts.isSatisfiesExpression(e)
  )
    e = e.expression;
  return e;
}

/** `expr` asserts the global object (`globalThis`, `global`). */
export function assertsGlobalObject(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
): boolean {
  const name = stdlibGlobalNameOf(lowerer, assertedSource(expr.expression));
  return name === "globalThis" || name === "global";
}

/** The assertion a binding initializer is, when it keeps the global object:
 * bindings of it hold that object rather than a native value of the
 * asserted type. A target with no native layout keeps the object as well
 * (the assertion lowers to the checked-dynamic value either way). */
export function keptIdentityAssertion(
  lowerer: Lowerer,
  initializer: ts.Expression,
): ts.AsExpression | ts.TypeAssertion | undefined {
  let e = initializer;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isAsExpression(e) && !ts.isTypeAssertion(e)) return undefined;
  if (!assertsGlobalObject(lowerer, e)) return undefined;
  const target = lowerer.mapTypeOf(lowerer.checker.getTypeFromTypeNode(e.type));
  return !target || target.kind === "dyn" || extractionCopiesReference(lowerer, target)
    ? e
    : undefined;
}
