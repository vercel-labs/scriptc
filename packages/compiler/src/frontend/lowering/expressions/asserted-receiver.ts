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
import { varRef } from "../../../ir/build.js";
import type { Lowerer } from "../lowerer.js";
import { tryLowerExpression } from "./try-lower-expression.js";
import { locOf } from "../../program.js";
import { checkedArmExtraction } from "../coercions/unions.js";
import { assertedOptionalExtension, hostedStorageView } from "./hosted-narrowing.js";
import { nsMemberIdentOf } from "../lower-namespaces.js";

/** The assertion node at the root of `node`, through parentheses; null
 * when `node` is not an (`as` / `<T>`) assertion. */
export function assertedReceiverNode(
  node: ts.Expression,
): ts.AsExpression | ts.TypeAssertion | null {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isAsExpression(e) || ts.isTypeAssertion(e) ? e : null;
}

/** The assertion a non-null assertion wraps (`(value as T | undefined)!`),
 * through parentheses; null for every other node. */
function nonNullAssertedNode(node: ts.Expression): ts.AsExpression | ts.TypeAssertion | null {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isNonNullExpression(e) ? assertedReceiverNode(e.expression) : null;
}

/** The record a possibly absent value holds when it is present: the one
 * arm beside `undefined` and `null`. Null for any other type. */
function presentRecord(lowerer: Lowerer, type: IrType): (IrType & { kind: "record" }) | null {
  if (type.kind !== "union") return null;
  const present = (lowerer.unions.get(type.unionId)?.arms ?? []).filter((arm) => !isUnitType(arm));
  const only = present[0];
  return present.length === 1 && only?.kind === "record" ? only : null;
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

/** The binding `node` names, through parentheses and the non-null
 * assertion: `(x).member` and `x!.member` read the same binding `x` does.
 * A namespace-import member (`ns.x`) names the exporter's binding: the
 * checker types the access at the exported assertion, while the lowering
 * reads the exporter's global, so its member name resolves like a bare
 * reference. Null for any other receiver expression. */
function bindingIdentifier(lowerer: Lowerer, node: ts.Expression): ts.Identifier | null {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return e;
  return ts.isPropertyAccessExpression(e) ? nsMemberIdentOf(lowerer, e) : null;
}

/** Whether the binding `ident` names DECLARES `member`: its annotation or
 * the asserted type of its initializer. Checker-only, and narrowing never
 * enters a declaration's own type, so a member a test narrows in at a use
 * site is not one the declaration holds. */
function declaredMember(lowerer: Lowerer, ident: ts.Identifier, member: string): boolean {
  const decl = lowerer.checker.getSymbolAtLocation(ident)?.valueDeclaration;
  if (decl === undefined) return false;
  const name = ts.isParameter(decl)
    ? decl.name
    : ts.isVariableDeclaration(decl)
      ? decl.name
      : undefined;
  if (name === undefined || !ts.isIdentifier(name)) return false;
  return (
    lowerer.checker.getPropertyOfType(lowerer.checker.getTypeAtLocation(name), member) !== undefined
  );
}

/** A member access whose asserted type adds a member the value's own record
 * layout does not hold (assertedOptionalExtension): `x.member` on a binding
 * whose declared type is an optional extension of the layout it stores, or
 * on an assertion `(value as T)` directly. The checker admits the member;
 * Node reads it off the object the binding holds.
 *
 * `storage` is the layout of that object; `field` is the member as the
 * asserted type declares it. Null for every other access — a member the
 * stored layout declares is an ordinary field of it. An optional chain
 * over a value whose layout is a record (`x?.member`) needs no separate
 * answer: its nullish test never fires. Over a nullable value
 * (`(x as T | undefined)?.member`) the chain's guard binds the present
 * record to the receiver, and that record is the object read here; the
 * non-null spelling (`(x as T | undefined)!.member`) reads the same one. */
function assertedOptionalMember(
  lowerer: Lowerer,
  receiver: ts.Expression,
  member: string,
): {
  asserted: IrType & { kind: "record" };
  storage: IrType & { kind: "record" };
  field: { name: string; type: IrType };
} | null {
  // The value's own layout: the assertion erases (Node reads the property
  // off the value), and a binding stores what its initializer produced.
  const assertion = assertedReceiverNode(receiver);
  const nonNull = assertion ? null : nonNullAssertedNode(receiver);
  let storage: IrType | null | undefined;
  let binding: ts.Identifier | null = null;
  if (assertion) {
    storage =
      lowerer.chainRecvByNode.get(receiver)?.type ??
      lowerer.mapTypeOf(lowerer.typeOf(assertion.expression));
  } else if (nonNull) {
    // `(value as T | undefined)!.member`: the non-null assertion erases
    // too, and reads the record the value holds when it is present.
    const operand = lowerer.mapTypeOf(lowerer.typeOf(nonNull.expression));
    storage = operand ? (presentRecord(lowerer, operand) ?? operand) : operand;
  } else {
    binding = bindingIdentifier(lowerer, receiver);
    if (binding === null) return null;
    storage = lowerer.peekLocal(binding)?.type ?? lowerer.globalOf(binding)?.type;
  }
  // Cheap rejection for the ordinary `x.member` read: the binding's own
  // layout answers it, so no asserted member is involved.
  if (storage?.kind !== "record") return null;
  if (lowerer.shapes.get(storage.shapeId)?.fields.some((f) => f.name === member)) {
    return null;
  }
  // A binding's assertion is its DECLARED type. A member a narrowing test
  // adds (`"k" in x`, `typeof x.k === "string"`) is not one the assertion
  // declares, and its read has its own lowering — the checked-dynamic
  // keyed read — which this hook leaves byte-identical. Parentheses and
  // the non-null assertion spell the same binding.
  if (binding !== null && !declaredMember(lowerer, binding, member)) return null;
  // The asserted type may spell the added member as an intersection
  // (`Base & { icons?: unknown }`) or as a declared record or interface
  // that extends the stored one (`item as WithIcons`); both only ADD
  // members Node reads off the object.
  const asserted = lowerer.mapTypeOf(lowerer.typeOf(receiver));
  if (asserted?.kind !== "record") return null;
  const field = lowerer.shapes.get(asserted.shapeId)?.fields.find((f) => f.name === member);
  if (!field) return null;
  if (!assertedOptionalExtension(lowerer, storage, asserted)) return null;
  return { asserted, storage, field };
}

/** The asserted-only optional member read: `(value as T).member`, or a
 * binding whose asserted type `T` only adds optional members to the record
 * layout the value has (assertedOptionalExtension). Node erases the
 * assertion and reads the property off the value, so the answer comes from
 * the record's kept source (assertedOnlyFieldRead) — the value when the
 * object carries the key, undefined when it does not. Null for every other
 * read, which keeps its own lowering.
 *
 * A read the source cannot answer (a layout that cannot keep a source, a
 * name on Object.prototype) is refused by name: answering the width copy's
 * absent slot with undefined would be a silent divergence. */
export function assertedOptionalMemberRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  const member = assertedOptionalMember(lowerer, access.expression, access.name.text);
  if (member === null) return null;
  const assertion = assertedReceiverNode(access.expression);
  // Inside an optional chain's guard the receiver is already evaluated: the
  // chain bound its present value to the receiver node.
  const value =
    lowerer.chainRecvByNode.get(access.expression) ??
    lowerer.lowerExpr(assertion?.expression ?? access.expression);
  if (value.type.kind !== "record") {
    // `(value as T | undefined)!.member`: the value is still nullable
    // here, and the member has no slot in the record it holds when present.
    if (nonNullAssertedNode(access.expression) && presentRecord(lowerer, value.type))
      lowerer.unsupported(
        "SC1090",
        access,
        `reading '${access.name.text}' through a non-null assertion over a type assertion to a member the value's own layout does not hold (rule the absent value out first, then assert the type)`,
      );
    return null;
  }
  if (!assertedOptionalExtension(lowerer, value.type, member.asserted)) return null;
  const answer = lowerer.assertedOnlyFieldRead(
    access.name.text,
    value.type,
    () => value,
    member.field.type,
    locOf(access),
  );
  if (answer !== null) return answer;
  lowerer.unsupported(
    "SC1090",
    access,
    `reading '${access.name.text}' through a type assertion to a member the value's own layout does not hold (the record's kept source properties cannot answer it; declare the member on the value's type)`,
  );
}

/** The write twin of assertedOptionalMemberRead. Node's write adds or
 * replaces the property on the object itself; the record the binding holds
 * has no slot for it, and a width copy would take the write and drop it —
 * a silent divergence. Refused by name instead. */
export function assertedOnlyMemberWrite(
  lowerer: Lowerer,
  receiver: ts.Expression,
  member: string,
  blame: ts.Node,
): void {
  if (assertedOptionalMember(lowerer, receiver, member) === null) return;
  lowerer.unsupported(
    "SC1090",
    blame,
    `writing '${member}' through a type assertion to a member the value's own layout does not hold (the write would land on a converted copy; declare the member on the value's type)`,
  );
}

/* ── Mutations through an assertion ──────────────────────────────────────
 * Node erases every type-level wrapper, so a member write, update or
 * `delete` through `(value as View)` changes the object `value` names. A
 * record assertion that changes layout lowers to a converted copy instead,
 * and a mutation of that temporary is dropped without a diagnostic. Every
 * mutation site therefore addresses the assertion's operand in place when
 * its own layout holds the member, and refuses by name when it does not. */

/** The operand a member mutation addresses through a chain of type
 * assertions: `(o as View).k` names `o`, and `(o as unknown as View)["k"]`
 * the same. Parentheses, `satisfies` and the non-null assertion are erased
 * wrappers too, so an assertion under them is still found
 * (`(o as View)!.k`, `((o as View) satisfies View).k`). The operand is the
 * expression under the INNERMOST assertion of the chain: a wrapper below
 * it belongs to the operand, whose own lowering keeps the value's identity
 * (`(o! as View).k` addresses `o!`, the narrowed value). Null when no
 * `as`/`<T>` wraps the receiver (a mutation there keeps the ordinary
 * lowering). */
export function assertionOperandOf(node: ts.Expression): ts.Expression | null {
  let operand: ts.Expression | null = null;
  let current: ts.Expression = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertion(current)) {
      current = current.expression;
      operand = current;
      continue;
    }
    break;
  }
  return operand;
}

/** The record a value of `type` is when it is present: the type itself, or
 * the one record arm of a union whose other arms are all `undefined` or
 * `null`. Null for every other type. */
export function presentRecordLayout(
  lowerer: Lowerer,
  type: IrType | null | undefined,
): (IrType & { kind: "record" }) | null {
  if (!type) return null;
  if (type.kind === "record") return type;
  if (type.kind !== "union") return null;
  let record: (IrType & { kind: "record" }) | null = null;
  for (const arm of lowerer.unions.get(type.unionId)?.arms ?? []) {
    if (isUnitType(arm)) continue;
    if (arm.kind !== "record" || record !== null) return null;
    record = arm;
  }
  return record;
}

/** The value a mutation through an assertion addresses: the unasserted
 * `operand`, and the record `layout` it has when it is present (its own
 * type, or its one record arm when it may also be `undefined` or `null`). */
export interface ErasedRecordOperand {
  operand: ts.Expression;
  layout: IrType & { kind: "record" };
}

/** The record operand a mutation through `receiver` addresses, decided from
 * static types alone so the operand is lowered exactly once. Null when no
 * assertion wraps the receiver, or when the operand is not a record: a
 * dyn/unknown cast is an identity-preserving view, and class instances,
 * arrays and handles never convert into a copy. */
export function erasedRecordOperand(
  lowerer: Lowerer,
  receiver: ts.Expression,
): ErasedRecordOperand | null {
  const operand = assertionOperandOf(receiver);
  if (operand === null) return null;
  const layout = presentRecordLayout(lowerer, lowerer.mapTypeOf(lowerer.typeOf(operand)));
  return layout === null ? null : { operand, layout };
}

/** The operand of `erased`, lowered once. A value that may be `undefined`
 * or `null` is narrowed to its record arm with a check: the assertion
 * claimed the value is there, and when it is not, the mutation throws the
 * TypeError Node gives it (`message` names it for the unit found). Null
 * when the nullable value has no checked extraction; a value that lowers
 * to anything but such a union (a generic body, an aliased layout) is
 * returned as it is, and the caller's own receiver rules decide. */
export function lowerErasedRecordOperand(
  lowerer: Lowerer,
  erased: ErasedRecordOperand,
  message: (unit: "undefined" | "null") => string,
): IrExpr | null {
  return narrowErasedRecordValue(
    lowerer,
    lowerer.lowerExpr(erased.operand),
    locOf(erased.operand),
    message,
  );
}

/** lowerErasedRecordOperand's narrowing, over an operand already lowered:
 * a caller that must evaluate something between the operand and the check
 * (a plain assignment's right-hand side) holds the operand first and
 * narrows the held value. */
export function narrowErasedRecordValue(
  lowerer: Lowerer,
  value: IrExpr,
  loc: SrcLoc,
  message: (unit: "undefined" | "null") => string,
): IrExpr | null {
  if (value.type.kind !== "union") return value;
  const stored = presentRecordLayout(lowerer, value.type);
  if (stored === null) return value;
  const unionId = value.type.unionId;
  const unitOf = (arm: IrType): "undefined" | "null" =>
    arm.kind === "nullT" ? "null" : "undefined";
  const messages = new Set<string>();
  for (const arm of lowerer.unions.get(unionId)?.arms ?? [])
    if (isUnitType(arm)) messages.add(message(unitOf(arm)));
  if (messages.size <= 1) {
    const helper = lowerer.narrowedArmHelper(unionId, stored, loc, [...messages][0]);
    return helper === null ? null : lowerer.checkedNarrowCall(helper, value, stored, loc);
  }
  // `undefined` and `null` name different errors: test each arm in place.
  const local = lowerer.declareHiddenLocal("%asserted", value.type);
  const extracted = checkedArmExtraction(
    lowerer,
    varRef(local.id, value.type, loc),
    lowerer.armTag(unionId, stored),
    stored,
    (found) => (isUnitType(found) ? message(unitOf(found)) : null),
  );
  if (extracted === null) return null;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: extracted,
    type: stored,
    loc,
  };
}

/** Whether `access` is the target of a plain assignment (`x.k = v`), as
 * opposed to an update that reads the member first. */
export function plainAssignmentTarget(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  let use: ts.Node = access;
  while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
  const parent = use.parent;
  return (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.left === use &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** Node's TypeError for a member write or update whose receiver is
 * `undefined` or `null`: a plain assignment never reads the member, every
 * other update reads it first. */
export function nullishMutationMessage(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  member: string,
): (unit: "undefined" | "null") => string {
  const set = plainAssignmentTarget(access);
  return (unit) =>
    set
      ? `Cannot set properties of ${unit} (setting '${member}')`
      : `Cannot read properties of ${unit} (reading '${member}')`;
}

/** A mutation whose receiver goes through a record assertion that changes
 * layout (`(o as View).k = v`, `(o as View)[k] += 1`): the asserted
 * expression lowers to a converted copy, so a mutation of it would be
 * dropped. Null for every other receiver, which the ordinary lowering
 * mutates in place (no assertion, a dyn operand, an assertion to the
 * operand's own layout). */
export function convertingAssertion(
  lowerer: Lowerer,
  receiver: ts.Expression,
): (ErasedRecordOperand & { asserted: IrType & { kind: "record" } }) | null {
  const erased = erasedRecordOperand(lowerer, receiver);
  if (erased === null) return null;
  const asserted = lowerer.mapTypeOf(lowerer.typeOf(receiver));
  if (asserted?.kind !== "record" || asserted.shapeId === erased.layout.shapeId) return null;
  return { ...erased, asserted };
}

/** A keyed write or update through a converting assertion
 * (`(o as View)[k] = v`, `(o as View)[k] += 1`, `(o as View)[k]++`). */
export function copiedKeyedWrite(
  lowerer: Lowerer,
  target: ts.ElementAccessExpression,
): ReturnType<typeof convertingAssertion> {
  return convertingAssertion(lowerer, target.expression);
}

/** Refuses the keyed mutations copiedKeyedWrite names. A caller that can
 * mutate the operand in place does so first. */
export function fenceCopiedKeyedWrite(lowerer: Lowerer, target: ts.ElementAccessExpression): void {
  const copied = copiedKeyedWrite(lowerer, target);
  if (copied === null) return;
  lowerer.unsupported(
    "SC1090",
    target,
    `a keyed write through a type assertion that converts '${lowerer.fmt(copied.layout)}' into '${lowerer.fmt(copied.asserted)}' (Node erases the assertion and writes to the value itself; the conversion builds a copy, so the write would land on the temporary and disappear — assign a declared member by its literal name, or write through the value's own type)`,
  );
}
