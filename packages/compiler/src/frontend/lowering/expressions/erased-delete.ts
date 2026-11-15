/* A member `delete` through a chain of type assertions:
 * `delete (o as View).k`, `delete (o as unknown as View)["k"]`,
 * `delete (o as View)!.k`, `delete ((o as View) satisfies View).k`.
 *
 * Node erases a type assertion, so the delete names the very object the
 * operand names: the assertion only decides what the checker accepts. The
 * asserted view's conversion may instead build a fresh width record
 * (`%rec.width`), and a delete that addresses that temporary would land on
 * the copy and vanish without a diagnostic.
 *
 * A delete therefore addresses the assertion's operand and lands in place
 * when the operand's OWN stored layout holds the member as a deletable slot
 * — an optional field's absent state, or a pure `Record<string, T>` key.
 * Any other layout has nothing to delete, so the caller refuses by name
 * instead of dropping the delete. Only a RECORD operand converts into a
 * copying width record; a dyn/unknown cast is an identity-preserving view,
 * and the ordinary lowering already deletes through it, so those keep it
 * (also exactly Node). The static type decides before lowering, so an
 * operand with side effects is lowered exactly once.
 *
 * The other erased wrappers are part of the same chain. A non-null
 * assertion or a `satisfies` AROUND an assertion (`(o as View)!.k`) hides
 * the assertion from a test that only looks at the receiver's outermost
 * node, and the delete would land on the copy again; both are looked
 * through. An operand that may be `undefined` or `null`
 * (`delete (maybe as View).k`) converts into the same copy once the
 * assertion drops the unit arms, so it is addressed in place too: the
 * record arm is extracted with a check, and a nullish value throws the
 * TypeError Node's ToObject gives a `delete`. */
import * as ts from "../../ts7/adapter.js";
import { BOOL, STRING, type IrExpr, type IrStmt, type SrcLoc } from "../../../ir/ir.js";
import { locOf } from "../../program.js";
import type { Lowerer } from "../lowerer.js";
import { markSloppyRecordWrites } from "../frozen-records.js";
import { recordMayKeepSource } from "../record-sources.js";
import { isStrictCode } from "../strict-mode.js";
import { isPureReference } from "../effect-free.js";
import { isSafeToRepeat } from "./evaluation-safety.js";
import { literalFieldKeys } from "./keyed-field-targets.js";
import {
  type ErasedRecordOperand,
  erasedRecordOperand,
  lowerErasedRecordOperand,
} from "./asserted-receiver.js";

/** The constant property key of a `delete` target: the name of a dot
 * access, or the one key of a bracket access spelled as a literal or
 * proved by a literal-typed binding (`const key = "a"`). A key of several
 * literals folds to nothing — deleting it would need per-key dispatch, so
 * the record branch refuses and names the keys. Consistent with keyed
 * record reads/writes (literalFieldKeys), the key expression is not
 * evaluated: only a literal or an identifier folds, and an identifier
 * read is pure. */
export function constantDeleteKey(lowerer: Lowerer, target: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (!ts.isElementAccessExpression(target)) return null;
  const keyNode = target.argumentExpression;
  if (ts.isStringLiteralLike(keyNode)) return keyNode.text;
  if (!ts.isIdentifier(keyNode)) return null;
  const keys = literalFieldKeys(lowerer, keyNode);
  return keys?.length === 1 ? keys[0]! : null;
}

/** The property key a `delete` evaluates for an index-signature record: a
 * dot access's name, or the bracket key converted to a string the way a
 * keyed record read does. */
export function lowerDeleteKey(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): IrExpr {
  if (ts.isPropertyAccessExpression(target))
    return { kind: "strLit", value: target.name.text, type: STRING, loc: locOf(target.name) };
  return lowerDeleteComputedKey(lowerer, target.argumentExpression);
}

/** A bracket `delete` key lowered to the STRING a record key is stored
 * under: a dyn value goes through ToString, an optional wider than string
 * is narrowed, and anything else is refused by name. */
export function lowerDeleteComputedKey(lowerer: Lowerer, keyNode: ts.Expression): IrExpr {
  let key = lowerer.lowerExpr(keyNode);
  if (key.type.kind === "dyn") {
    key = { kind: "libCall", fn: "dyn.toStringCoerce", args: [key], type: STRING, loc: key.loc };
  }
  if (lowerer.runtimeOptionalWidening(key.type, STRING) !== null) {
    key = lowerer.ensureString(key, keyNode);
  }
  if (key.type.kind !== "string") {
    lowerer.unsupported(
      "SC1090",
      keyNode,
      `'delete' with '${lowerer.fmt(key.type)}' keys (index-signature and env keys are strings)`,
    );
  }
  return key;
}

/** The constant member a delete through an assertion names. */
const MISSING_ASSERTED_MEMBER = (member: string): string =>
  `'delete' of '${member}' through a type assertion to a member the value's own layout does not hold (Node erases the assertion and deletes from the operand; the asserted view's conversion would build a copy, so the delete would land on the temporary and disappear — declare the member on the value's type instead)`;

const UNKNOWN_ASSERTED_LAYOUT =
  "'delete' through a type assertion whose value has no statically known record layout (the asserted view's conversion would build a copy, so the delete would land on the temporary and disappear)";

const OPTIONAL_CHAIN_ASSERTED =
  "'delete' through an optional chain on an asserted value that may be undefined or null (the chain answers true for a nullish value, and the assertion's conversion would build a copy of a present one — narrow the value first, or delete through the value's own type)";

/** The TypeError Node's ToObject gives a `delete` whose receiver is
 * `undefined` or `null`; it names neither the receiver nor the key. */
export const DELETE_NULLISH_RECEIVER = "Cannot convert undefined or null to object";

/** What a member `delete` through a chain of assertions addresses.
 *
 * - `operand`: the unasserted value to delete from, when its own stored
 *   layout can hold the member (the caller lowers it once, in place, with
 *   lowerErasedDeleteOperand). `layout` is that record layout: the
 *   operand's own type, or its one record arm when the operand may also be
 *   `undefined` or `null`.
 * - `refuse`: the assertion names a constant member the operand's layout
 *   does not hold at all, so there is nothing a delete could remove.
 *
 * Null when no assertion wraps the receiver, or when the operand is not a
 * RECORD — a dyn/unknown cast is an identity-preserving view the ordinary
 * lowering already deletes through. */
export type ErasedDeletePlan = ErasedRecordOperand | { refuse: string };

export function erasedDeletePlan(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ErasedDeletePlan | null {
  const erased = erasedRecordOperand(lowerer, target.expression);
  if (erased === null) return null;
  const { operand, layout } = erased;
  // `delete (maybe as View)?.k`: the chain answers `true` for a nullish
  // value without deleting, where the narrowing below throws.
  if (target.questionDotToken && lowerer.mapTypeOf(lowerer.typeOf(operand))?.kind !== "record")
    return { refuse: OPTIONAL_CHAIN_ASSERTED };
  const shape = lowerer.shapes.get(layout.shapeId);
  if (!shape) return { refuse: UNKNOWN_ASSERTED_LAYOUT };
  const member = constantDeleteKey(lowerer, target);
  // A key only a literal proves, a pure index signature's key, and a
  // declared field all name a slot the operand's own layout has. A declared
  // field that is REQUIRED (and the hybrid/optional-checked-dynamic cases)
  // is not deletable, but lowerRecordMemberDelete names that reason better
  // than this plan can, so it decides there.
  const held =
    (shape.indexValue !== undefined && shape.fields.length === 0 && !shape.tuple) ||
    member === null ||
    (!shape.tuple && shape.fields.some((field) => field.name === member)) ||
    // A checked record can hold a key its own type does not declare in the
    // kept source it notes from the value it was converted from
    // (record-sources.ts): the delete addresses the operand and removes the
    // key there, exactly as Node deletes the property from the one object.
    recordMayKeepSource(lowerer, layout);
  return held ? { operand, layout } : { refuse: MISSING_ASSERTED_MEMBER(member) };
}

/** The value an erased delete addresses, lowered once. An operand that may
 * be `undefined` or `null` is narrowed to its record arm with a check: the
 * assertion claimed the value is there, and when it is not, the delete
 * throws the TypeError Node's ToObject gives. */
export function lowerErasedDeleteOperand(
  lowerer: Lowerer,
  plan: ErasedRecordOperand,
  blame: ts.Node,
): IrExpr {
  return (
    lowerErasedRecordOperand(lowerer, plan, () => DELETE_NULLISH_RECEIVER) ??
    lowerer.unsupported("SC1090", blame, UNKNOWN_ASSERTED_LAYOUT)
  );
}

/** A record member delete: the store, and — for a caller that needs the
 * `delete` VALUE — the member's presence AFTER it (`delete` answers `false`
 * exactly when the member survives, which only a frozen record makes it
 * do). */
interface RecordDeletePlan {
  stmt: IrStmt;
  present: IrExpr | null;
}

/** The statement that deletes `member` from `obj` — a pure index-signature
 * key (`recordKeyDelete`, the overflow Map delete) or a declared OPTIONAL
 * field's ABSENT state — or a named refusal when the shape cannot delete
 * it. `key` lowers the bracket key lazily: the constant-field path never
 * evaluates it (its key expression is a literal or a pure identifier
 * read). */
export function lowerRecordMemberDelete(
  lowerer: Lowerer,
  expr: ts.DeleteExpression,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  obj: IrExpr,
  key: () => IrExpr,
): IrStmt {
  return recordDeletePlan(lowerer, expr, target, obj, key, false).stmt;
}

/** `delete` in VALUE position over a record: the same in-place delete a
 * statement performs, then Node's boolean answer. The receiver and a
 * computed key are bound once (the presence test reads them again), and a
 * receiver a key that runs program code could replace is held before the
 * key evaluates it, as JavaScript reads the receiver first. The answer is
 * read from the member itself after the delete rather than from the frozen
 * bit: a frozen record keeps the member (sloppy code) and answers `false`,
 * while a member that was never there is gone and answers `true`. Strict
 * code never reaches the answer for a refused delete — the frozen guard
 * throws first. */
export function lowerRecordDeleteExpr(
  lowerer: Lowerer,
  expr: ts.DeleteExpression,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  obj: IrExpr,
): IrExpr {
  const loc = locOf(expr);
  const stmts: IrStmt[] = [];
  const receiver = bindOnce(
    lowerer,
    stmts,
    obj,
    "%deleteReceiver",
    loc,
    keyEvaluatesCode(lowerer, target),
  );
  let loweredKey: IrExpr | null = null;
  const key = (): IrExpr => {
    if (loweredKey === null)
      loweredKey = bindOnce(lowerer, stmts, lowerDeleteKey(lowerer, target), "%deleteKey", loc);
    return loweredKey;
  };
  const plan = recordDeletePlan(lowerer, expr, target, receiver, key, true);
  stmts.push(plan.stmt);
  const present = plan.present ?? { kind: "boolLit", value: true, type: BOOL, loc };
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "unary", op: "!", operand: present, type: BOOL, loc },
    type: BOOL,
    loc,
  };
}

/** Whether evaluating this delete's key runs program code. JavaScript
 * evaluates the receiver first and deletes from that value, so a key that
 * runs program code may reassign the receiver's binding or the field the
 * receiver reads before the delete addresses it. A dot access and a
 * constant bracket key spell the key with no program code; a bracket key
 * that is a literal, a pure read or a literal-typed binding's read cannot
 * run any either — except an untyped key, whose own ToString conversion
 * can. */
function keyEvaluatesCode(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  if (!ts.isElementAccessExpression(target)) return false;
  let keyNode: ts.Expression = target.argumentExpression;
  while (ts.isParenthesizedExpression(keyNode)) keyNode = keyNode.expression;
  if (ts.isLiteralExpression(keyNode) || constantDeleteKey(lowerer, target) !== null) return false;
  if (!isPureReference(lowerer, keyNode)) return true;
  return lowerer.mapTypeOf(lowerer.typeOf(keyNode))?.kind === "dyn";
}

/** `value`, or a hidden local initialized with it when reading it twice
 * would repeat an effect (a varRef or a literal reads for free) — or when
 * `hold` asks for the value as it is at this point, because something
 * evaluated later can replace it. */
function bindOnce(
  lowerer: Lowerer,
  stmts: IrStmt[],
  value: IrExpr,
  name: string,
  loc: SrcLoc,
  hold = false,
): IrExpr {
  if (!hold && (isSafeToRepeat(value) || value.kind === "strLit" || value.kind === "numLit"))
    return value;
  const slot = lowerer.declareHiddenLocal(name, value.type);
  stmts.push({ kind: "varDecl", localId: slot.id, init: value, loc });
  return { kind: "varRef", localId: slot.id, type: value.type, loc };
}

function recordDeletePlan(
  lowerer: Lowerer,
  expr: ts.DeleteExpression,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  obj: IrExpr,
  key: () => IrExpr,
  withPresent: boolean,
): RecordDeletePlan {
  if (obj.type.kind !== "record")
    return lowerer.unsupported("SC1090", expr, UNKNOWN_ASSERTED_LAYOUT);
  const loc = locOf(expr);
  const shape = lowerer.shapes.get(obj.type.shapeId);
  if (shape?.indexValue && shape.fields.length === 0 && !shape.tuple) {
    const shapeId = obj.type.shapeId;
    const loweredKey = key();
    const stmt = markSloppyRecordWrites(
      lowerer,
      { kind: "recordKeyDelete", obj, shapeId, key: loweredKey, loc },
      expr,
    );
    // A pure index-signature record keeps its keys in the overflow map, so
    // its own presence test after the delete is the map's.
    const present: IrExpr | null = withPresent
      ? { kind: "recordOvfHas", obj, shapeId, key: loweredKey, type: BOOL, loc }
      : null;
    return { stmt, present };
  }
  // `delete r.f` of a declared OPTIONAL field (undefined-armed slot)
  // writes the field's ABSENT state: a monomorphic shape cannot remove
  // its slot, but the slot remembers that no property exists, so `in`
  // answers false, Object.keys skips it, and JSON.stringify drops it,
  // while a later write makes it present again. Constant keys only
  // (dot access or a literal bracket); required fields keep the honest
  // fence below.
  const constantKey = constantDeleteKey(lowerer, target);
  const field =
    constantKey !== null && !shape?.tuple
      ? shape?.fields.find((f) => f.name === constantKey)
      : undefined;
  if (field) {
    const absent = lowerer.absentFieldValue(field, loc);
    if (absent) {
      const stmt = markSloppyRecordWrites(
        lowerer,
        {
          kind: "recordSet",
          obj,
          shapeId: obj.type.shapeId,
          field: field.name,
          value: absent,
          loc,
        },
        expr,
        true,
      );
      // The field's own presence after the delete: an undefined-armed slot
      // is absent exactly when it reads as the ABSENT state, and a frozen
      // record kept its value, so the delete answered false.
      const present: IrExpr | null = withPresent
        ? lowerer.recordFieldPresent(obj, obj.type.shapeId, field.name, loc)
        : null;
      return { stmt, present };
    }
  }
  if (shape?.indexValue) {
    lowerer.unsupported(
      "SC1090",
      expr,
      "'delete' of hybrid index-signature keys (declared struct slots and overflow entries answer differently — model deletable dynamic keys with a pure Record<string, T>)",
    );
  }
  // A key of SEVERAL literals names no single slot: say that instead of
  // blaming a field the caller never named.
  const keyNames =
    constantKey === null && ts.isElementAccessExpression(target)
      ? literalFieldKeys(lowerer, target.argumentExpression)
      : null;
  if (keyNames !== null && keyNames.length > 1) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'delete' through keys of ${keyNames.length} literals (${keyNames.map((k) => `'${k}'`).join(", ")}; delete one constant key at a time, or switch over the key)`,
    );
  }
  // A constant key the shape does not DECLARE lives in the record's kept
  // source (the undeclared-keys table, record-sources.ts): Node's object
  // still has that own property, so the delete removes it there, and every
  // reflective surface — Object.keys, `in`, hasOwn, JSON, spread, inspect —
  // already answers from that table. A key the table never held is already
  // absent, so the delete answers true and changes nothing. A frozen record
  // keeps the key (sloppy code answers false) or refuses the delete
  // (strict code throws), which the runtime call decides from the delete's
  // own mode.
  if (
    constantKey !== null &&
    field === undefined &&
    !shape?.indexValue &&
    recordMayKeepSource(lowerer, obj.type)
  ) {
    const deleted: IrExpr = {
      kind: "libCall",
      fn: "record.sourceDelete",
      args: [
        obj,
        { kind: "strLit", value: constantKey, type: STRING, loc },
        { kind: "boolLit", value: isStrictCode(expr), type: BOOL, loc },
      ],
      type: BOOL,
      loc,
    };
    lowerer.recordSourcesPossible = true;
    // The key must live in this record's own kept source. A value that is a
    // view or a copy of a record declaring the key holds it in that record's
    // slot instead, which this delete cannot reach: refused once every
    // conversion is known (refuseSourceFieldDeletes).
    lowerer.recordSourceDeletes.push({ shapeId: obj.type.shapeId, key: constantKey, loc });
    if (!withPresent) return { stmt: { kind: "exprStmt", expr: deleted, loc }, present: null };
    // `delete` in value position: the call answers whether the property is
    // gone, which IS the delete's value, so it is held once and the
    // caller's `!present` reads it.
    const slot = lowerer.declareHiddenLocal("%sourceDeleted", BOOL);
    return {
      stmt: { kind: "varDecl", localId: slot.id, init: deleted, loc },
      present: {
        kind: "unary",
        op: "!",
        operand: { kind: "varRef", localId: slot.id, type: BOOL, loc },
        type: BOOL,
        loc,
      },
    };
  }
  // A declared field with no absent state: the type says it is always
  // there, so no delete can remove it without making the type lie.
  if (field !== undefined) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'delete' of '${field.name}': the operand's type '${lowerer.fmt(obj.type)}' declares '${field.name}' required, so it cannot be absent (only an optional field, 'f?: T', has an absent state that Object.keys, 'in' and JSON.stringify follow; make '${field.name}' optional if the program must remove it)`,
    );
  }
  if (constantKey !== null && !shape?.indexValue) {
    lowerer.unsupported(
      "SC1090",
      expr,
      `'delete' of a key '${constantKey}' the record's layout does not declare (only an optional declared field, an index-signature key, or an undeclared key a checked record keeps from its source can be removed)`,
    );
  }
  lowerer.unsupported(
    "SC1090",
    expr,
    "'delete' of required record fields (the shape's slot cannot be removed — only an optional field (`f?: T`) has an absent state, which Object.keys, 'in', and JSON.stringify follow; make the field optional if the program must remove it)",
  );
}
