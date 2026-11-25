/* An object literal that flows into a checked-identity view.
 *
 * A declared type becomes a view (class-protocols.ts) when its values must
 * stay live objects: a literal implements one of its data members with a
 * get/set accessor, a class implements it, an island value reaches it. The
 * type then maps to the checked-dynamic value.
 *
 * A literal's own checker type names each data member by its initializer:
 * `current: undefined` holds only undefined, `items: []` is an array of
 * nothing, `count: 0` a number. The declared type is what the program
 * stores later, so the declared type decides what the literal's members
 * hold, as it does for a literal built at a record type:
 *
 * - A literal with no accessor that is returned, passed or stored at the
 *   declared type is a record seen through a live reference. The record has
 *   the declared type's slots (viewLiteralStorage): a data member has the
 *   type the declared type gives it, and a member the declared type makes
 *   optional and the literal leaves out is a slot too, absent until a write
 *   through the view.
 * - A literal with an accessor, and any literal that initializes a
 *   declaration annotated with the view, is the dynamic object itself: an
 *   accessor is a property of that object, and a record's accessor slots
 *   have no live view (every read through one would copy the record). Its
 *   array and object members are built at their declared types and held by
 *   reference (lowerDeclaredMemberLiteral), so a typed read of the member
 *   answers the array the object holds, not a copy of a dynamic one. The
 *   same holds for a fresh literal stored into a member of a view later.
 *
 * The literal's own key order is kept; added optional members follow it. */
import { DYN, accessorSlotProp } from "../../ir/ir.js";
import type { IrExpr, IrRecordField, IrType } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { declaredViewFields } from "../type-mapper.js";
import { PoisonError } from "./lowerer.js";
import type { Lowerer } from "./lowerer.js";

type RecordType = IrType & { kind: "record" };

/** The view a contextual type names, through null and undefined: the one
 * object type it holds, when that type keeps checked identity. */
export function viewTargetOf(lowerer: Lowerer, contextual: ts.Type): ts.Type | null {
  let target = contextual;
  if (contextual.isUnionType()) {
    const present = ts
      .constituentTypes(contextual)
      .filter((part) => (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
    if (present.length !== 1) return null;
    target = present[0]!;
  }
  if ((target.flags & ts.TypeFlags.Object) === 0 && !target.isIntersectionType()) return null;
  return lowerer.classImplementedProtocol(target) ? target : null;
}

/** The data slot a declared member gives a name: its data field, or what
 * its declared accessor reads or writes. */
function declaredSlot(declared: readonly IrRecordField[], name: string): IrRecordField | null {
  const data = declared.find((field) => field.name === name);
  if (data) return data;
  const getter = declared.find((field) => field.name === `%get:${name}`);
  if (getter?.type.kind === "func" && getter.type.ret.kind !== "void")
    return { name, type: getter.type.ret };
  const setter = declared.find((field) => field.name === `%set:${name}`);
  if (setter?.type.kind === "func" && setter.type.params.length === 1)
    return { name, type: setter.type.params[0]! };
  return null;
}

/** The layout of a literal with no accessor behind the view `target`, given
 * the record `own` its own type maps to; null when the view declares no
 * fixed layout, where the own type stands. */
export function viewLiteralStorage(
  lowerer: Lowerer,
  target: ts.Type,
  own: RecordType,
): RecordType | null {
  const ownShape = lowerer.shapes.get(own.shapeId);
  if (!ownShape || ownShape.tuple || ownShape.indexValue !== undefined) return null;
  const declared = declaredViewFields(target, lowerer.typeCtx);
  if (declared === null) return null;
  const fields: IrRecordField[] = ownShape.fields.map((field) =>
    field.name.startsWith("%") ? field : (declaredSlot(declared, field.name) ?? field),
  );
  const added: string[] = [];
  for (const field of declared) {
    if (accessorSlotProp(field.name) !== null || field.name.startsWith("%")) continue;
    if (ownShape.fields.some((mine) => mine.name === field.name)) continue;
    // Only a member the literal may leave out: the checker requires every
    // other one, so a required name missing here is one the own type could
    // not represent, and the literal's own lowering decides it.
    const member = lowerer.checker.getPropertyOfType(target, field.name);
    if (member === undefined || (member.flags & ts.SymbolFlags.Optional) === 0) continue;
    fields.push(field);
    added.push(field.name);
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const order = [
    ...(ownShape.declaredOrder ??
      ownShape.fields.filter((field) => !field.name.startsWith("%")).map((field) => field.name)),
    ...added,
  ];
  const storage: RecordType = {
    kind: "record",
    shapeId: lowerer.shapes.intern(fields, false, undefined, order),
  };
  // The record is seen through a live reference, so it must be a value the
  // checked-dynamic tier can hold; one that is not keeps the literal's own
  // layout and whatever that layout's conversion reports.
  return lowerer.dynConvertible(storage) ? storage : null;
}

/** A fresh array or object literal written into a member of a view (a
 * member of a literal that is the view's dynamic object, or the right-hand
 * side of a store through the view), as the checked-dynamic value the
 * member holds: the literal built at the member's declared type and held by
 * reference. Null when the expression is not such a literal or the declared
 * type gives it no layout; it is then built as a dynamic value, as before. */
export function lowerDeclaredMemberLiteral(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  let literal = node;
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
  if (!ts.isArrayLiteralExpression(literal) && !ts.isObjectLiteralExpression(literal)) return null;
  const contextual = lowerer.checker.getContextualType(literal);
  if (contextual === undefined) return null;
  const declared = lowerer.mapTypeOf(contextual);
  if (
    declared === null ||
    (declared.kind !== "array" && declared.kind !== "record" && declared.kind !== "union") ||
    !lowerer.dynConvertible(declared)
  )
    return null;
  // A literal the declared layout cannot build keeps its dynamic form: its
  // diagnostics are dropped with the attempt.
  const saved = lowerer.diagSink;
  const captured: typeof lowerer.diags = [];
  lowerer.diagSink = captured;
  let value: IrExpr;
  try {
    const built = lowerer.coerceInto(node, lowerer.lowerExprExpecting(node, declared), declared);
    value = lowerer.coerceToExpected(built, DYN);
  } catch (error) {
    lowerer.diagSink = saved;
    if (error instanceof PoisonError) return null;
    throw error;
  }
  lowerer.diagSink = saved;
  for (const diagnostic of captured) lowerer.pushDiag(diagnostic);
  return value.type.kind === "dyn" ? value : null;
}
