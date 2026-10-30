/* A record assertion used as the object of a member PRESENCE PROBE:
 * `typeof (stored as R).member`, `(stored as R).member !== undefined`,
 * `null != (stored as R).member`.
 *
 * Node erases a type assertion, so the read answers off the value actually
 * stored: arms of the stored union that declare the member answer their
 * slot, and the others answer undefined (native records are closed). An
 * eager checked extraction of R at the assertion would instead trap on
 * every other arm, turning the probe — code that exists precisely BECAUSE
 * the stored value may be another arm — into a TypeError where Node
 * answers "undefined".
 *
 * The assertion's extraction is therefore deferred to the member read.
 * lowerAsExpression erases it for this use; property access answers the
 * read per arm when `assertedMemberRead` can (arms that declare the member
 * against arms that do not), and applies the extraction the assertion
 * would otherwise have taken eagerly when it cannot
 * (applyDeferredAssertion).
 *
 * Only a probe defers. A real use of the asserted value — the member
 * called, compared by identity, or read in any other context — keeps the
 * checked extraction, so a lying assertion still throws at the use
 * (divergence 38's lying-assertion stance). Types don't lie; a probe
 * simply isn't the use.
 */
import * as ts from "../../ts7/adapter.js";
import { type IrExpr, type IrType, type SrcLoc, isUnitType, typeEquals } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { hostedStorageView } from "./hosted-narrowing.js";

/** The assertion node at the root of `node`, through parentheses; null
 * when `node` is not an (`as` / `<T>`) assertion. */
export function assertedReceiverNode(
  node: ts.Expression,
): ts.AsExpression | ts.TypeAssertion | null {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isAsExpression(e) || ts.isTypeAssertion(e) ? e : null;
}

/** The member a probe access names: a property access's name, or an
 * element access's literal key (the bracket spelling of the same read).
 * Null for an element key that is not a literal string or number. */
export type ProbeAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

export function probeMemberName(access: ProbeAccess): string | null {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  let key: ts.Expression = access.argumentExpression;
  while (ts.isParenthesizedExpression(key)) key = key.expression;
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  // JS object keys ARE strings: `o[0x10]` reads `o["16"]`.
  if (ts.isNumericLiteral(key)) return String(Number(key.text));
  return null;
}

/** The property or element access this assertion is the receiver of,
 * through parentheses: `(u as R).member`, `(u as R)["member"]`. Null for
 * any other use, for a non-literal element key, and for the optional
 * chains `(u as R)?.member` / `(u as R)?.["member"]` (a unit arm answers
 * undefined there instead of Node's read-of-undefined TypeError). */
function assertedReceiverAccess(assertion: ts.AsExpression | ts.TypeAssertion): ProbeAccess | null {
  let use: ts.Node = assertion;
  for (;;) {
    const parent = use.parent;
    if (parent && ts.isParenthesizedExpression(parent) && parent.expression === use) {
      use = parent;
      continue;
    }
    break;
  }
  const access = use.parent;
  if (access === undefined || access.questionDotToken !== undefined) return null;
  if (ts.isPropertyAccessExpression(access)) return access.expression === use ? access : null;
  if (!ts.isElementAccessExpression(access) || access.expression !== use) return null;
  return probeMemberName(access) === null ? null : access;
}

/** An operand that names the absent values (`undefined`, `null`), through
 * parentheses and the `void 0` spelling. */
function isAbsenceLiteral(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e)) return e.text === "undefined";
  return ts.isVoidExpression(e) && ts.isNumericLiteral(e.expression) && e.expression.text === "0";
}

/** The property access this assertion is the receiver of when the read is
 * a presence probe: the operand of `typeof`, or an operand of `===` /
 * `!==` / `==` / `!=` against undefined or null. Null for the optional
 * chain and for every real use (a call's callee, an identity comparison,
 * a read that flows into a typed slot), which keep the assertion's checked
 * extraction. */
export function assertedProbeAccessOf(
  assertion: ts.AsExpression | ts.TypeAssertion,
): ProbeAccess | null {
  const access = assertedReceiverAccess(assertion);
  if (access === null) return null;
  let use: ts.Node = access;
  while (ts.isParenthesizedExpression(use.parent) && use.parent.expression === use)
    use = use.parent;
  const parent = use.parent;
  if (parent === undefined) return null;
  if (ts.isTypeOfExpression(parent) && parent.expression === use) return access;
  if (ts.isBinaryExpression(parent)) {
    const comparable = parent.left === use || (parent.right === use && parent.left !== use);
    if (!comparable) return null;
    const op = parent.operatorToken.kind;
    const equality =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equality) return null;
    const other = parent.left === use ? parent.right : parent.left;
    if (isAbsenceLiteral(other)) return access;
  }
  return null;
}

/** True when the union's record arms read `member` unevenly: at least one
 * declares it as a data field and at least one does not (it declares a
 * getter instead, or nothing), or at least one answers it through a getter
 * while another arm has no read of it at all. Those are exactly the arms
 * assertedMemberRead answers per arm; anything else keeps the assertion's
 * extraction (and with it the checked-narrow fence for a lying one). An arm
 * with only a setter of that name reads undefined (Node never invokes a
 * setter on a read), so it counts as an arm with no read. */
export function partialRecordMember(lowerer: Lowerer, union: IrType, member: string): boolean {
  if (union.kind !== "union") return false;
  const arms = lowerer.unions.get(union.unionId)?.arms ?? [];
  let records = 0;
  let dataFields = 0;
  let getters = 0;
  let absent = 0;
  for (const arm of arms) {
    if (isUnitType(arm)) continue;
    if (arm.kind !== "record") return false;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple) return false;
    records++;
    if (shape.fields.some((field) => field.name === member)) dataFields++;
    else if (shape.fields.some((field) => field.name === `%get:${member}`)) getters++;
    else absent++;
  }
  if (records === 0) return false;
  return (dataFields > 0 && dataFields < records) || (getters > 0 && absent > 0);
}

/** The asserted record type whose checked extraction is deferred for the
 * probe `access`, or null when the read keeps the ordinary assertion
 * lowering. `value` is the assertion's lowered operand. */
export function deferredMemberReadTarget(
  lowerer: Lowerer,
  assertion: ts.AsExpression | ts.TypeAssertion,
  access: ProbeAccess,
  value: IrExpr,
): IrType | null {
  if (assertedProbeAccessOf(assertion) !== access) return null;
  if (value.type.kind !== "union") return null;
  const member = probeMemberName(access);
  if (member === null) return null;
  const target = lowerer.mapTypeOf(lowerer.checker.getTypeFromTypeNode(assertion.type));
  if (target?.kind !== "record") return null;
  if (!partialRecordMember(lowerer, value.type, member)) return null;
  return target;
}

/** Whether the property access `expr` is a probe read through an assertion
 * that the per-arm answer claims (the same shape deferredMemberReadTarget
 * recognizes). Checker-derived field targets must not claim it first: the
 * field target would apply the assertion's checked extraction and trap on
 * the arm the probe exists to detect. */
export function deferredProbeReadAccess(lowerer: Lowerer, access: ProbeAccess): boolean {
  const assertion = assertedReceiverNode(access.expression);
  if (assertion === null) return false;
  if (assertedProbeAccessOf(assertion) !== access) return false;
  const value = tryLowerExpression(lowerer, access.expression);
  return value !== null && deferredMemberReadTarget(lowerer, assertion, access, value) !== null;
}

/** The stored value of an `in` probe whose receiver is an erased assertion
 * (`"stream" in (stored as R)`): Node asks membership of the value actually
 * stored, which for a union of record shapes the union path answers per arm
 * — a unit arm (`api?: ...` asserted away) answering its TypeError, an
 * index-signature arm its own key. Null when the receiver is not such an
 * assertion, or the stored value is not such a union (those keep the
 * ordinary lowering, and its refusals). */
export function assertedInOperand(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  let rhs = node;
  while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
  if (!ts.isAsExpression(rhs) && !ts.isTypeAssertion(rhs)) return null;
  const stored = tryLowerExpression(lowerer, rhs.expression);
  if (stored === null || stored.type.kind !== "union") return null;
  const arms = lowerer.unions.get(stored.type.unionId)?.arms ?? [];
  const answerable = arms.every((arm) => {
    if (isUnitType(arm)) return true;
    if (arm.kind !== "record") return false;
    const shape = lowerer.shapes.get(arm.shapeId);
    return shape !== undefined && !shape.tuple;
  });
  return arms.length > 0 && answerable ? stored : null;
}

/** Apply the extraction lowerAsExpression would have applied to the
 * assertion's operand, for a member read with no per-arm answer. */
export function applyDeferredAssertion(
  lowerer: Lowerer,
  value: IrExpr,
  target: IrType,
  loc: SrcLoc,
): IrExpr {
  if (value.type.kind === "union" && target.kind !== "union" && !typeEquals(target, value.type)) {
    const helper = lowerer.narrowedArmHelper(value.type.unionId, target, loc);
    if (helper !== null) return lowerer.checkedNarrowCall(helper, value, target, loc);
  }
  if (target.kind === "union" || target.kind === "record") {
    const hosted = hostedStorageView(lowerer, value, target, loc);
    if (hosted) return hosted;
  }
  lowerer.assertedValues.set(value, target);
  return value;
}
