/* Checked narrowing for `.filter` with a written type predicate.
 *
 * A written predicate (`(p): p is Cat => ...`, or a guard function passed
 * as a value) is an assertion TypeScript does not check, so the filter loop
 * keeps the receiver's element type and the result converts to the
 * predicate's type afterwards, element by element:
 *
 *   - a union element to one of its arms, or to a union of some of its
 *     arms, by its tag;
 *   - a checked-dynamic element by dynCheck;
 *   - a class instance to a subclass by its class;
 *   - a tuple or record to one with the same fields, field by field.
 *
 * Each conversion throws the catchable TypeError of a checked extraction
 * when a kept element is not of the predicate's type, which is when the
 * predicate returned true for a value it does not describe. */
import { varRef } from "../../../ir/build.js";
import {
  BOOL,
  F64,
  STRING,
  isUnitType,
  typeEquals,
  type IrExpr,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../../ir/ir.js";
import { checkedClassAssertion } from "../class-assertions.js";
import { buildArrayConversion } from "../coercions/builders.js";
import type { Lowerer } from "../lowerer.js";
import { keyedHelperName } from "../stable-names.js";
import { typeKey } from "../../type-mapper.js";

/** The interned helper converting a `from[]` filter result to `to[]`, or
 * null when an element of `from` has no checked conversion to `to`.
 * `typeText` names the predicate's type in the TypeError. */
export function checkedFilterNarrowing(
  lowerer: Lowerer,
  from: IrType,
  to: IrType,
  typeText: string,
  loc: SrcLoc,
): string | null {
  const element = elementHelper(lowerer, from, to, loc, typeText);
  if (element === null) return null;
  const key = `filter.narrow:${typeKey(from)}:${typeKey(to)}:${typeText}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.narrow", key);
  lowerer.valueHelpers.set(key, name);
  const outT: IrType = { kind: "array", elem: to };
  lowerer.liftedFns.push(
    buildArrayConversion(
      name,
      { kind: "array", elem: from },
      { kind: "arrayLit", elems: [], type: outT, loc },
      (value, _index, result) => ({
        kind: "arrIntrinsic",
        method: "push",
        receiver: result,
        args: [{ kind: "call", callee: element, args: [value], type: to, loc }],
        type: F64,
        loc,
      }),
      loc,
    ),
  );
  return name;
}

/** The interned helper converting one `from` value to `to`, or null. */
function elementHelper(
  lowerer: Lowerer,
  from: IrType,
  to: IrType,
  loc: SrcLoc,
  typeText = lowerer.fmt(to),
): string | null {
  const key = `filter.narrow.value:${typeKey(from)}:${typeKey(to)}:${typeText}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  // A recursive type pair converts through the helper being built.
  if (lowerer.coercions.planning.has(key)) return null;
  lowerer.coercions.planning.add(key);
  const input = varRef("v.0", from, loc);
  let body: IrStmt[] | null;
  try {
    body = conversionBody(lowerer, input, from, to, typeText, loc);
  } finally {
    lowerer.coercions.planning.delete(key);
  }
  if (body === null) return null;
  const name = keyedHelperName(lowerer, "%narrow.checked", key);
  lowerer.valueHelpers.set(key, name);
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "v.0", name: "v", type: from }],
    returnType: to,
    locals: [{ id: "v.0", name: "v", type: from, mutable: false }],
    body,
    loc,
  });
  return name;
}

/** A converted value: `value` itself when the types are equal, or a call of
 * the conversion helper. */
function converted(
  lowerer: Lowerer,
  value: IrExpr,
  from: IrType,
  to: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (typeEquals(from, to)) return value;
  const helper = elementHelper(lowerer, from, to, loc);
  return helper === null ? null : { kind: "call", callee: helper, args: [value], type: to, loc };
}

/** The TypeError a kept element of another type throws. */
function typeError(message: string, loc: SrcLoc): IrStmt {
  return {
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [{ kind: "strLit", value: message, type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  };
}

function conversionBody(
  lowerer: Lowerer,
  input: IrExpr,
  from: IrType,
  to: IrType,
  typeText: string,
  loc: SrcLoc,
): IrStmt[] | null {
  if (typeEquals(from, to)) return [{ kind: "return", value: input, loc }];
  if (from.kind === "dyn")
    return [{ kind: "return", value: { kind: "dynCheck", value: input, type: to, loc }, loc }];
  if (from.kind === "object" && to.kind === "object") {
    const asserted = checkedClassAssertion(lowerer, input, to, loc);
    return asserted === null ? null : [{ kind: "return", value: asserted, loc }];
  }
  if (from.kind === "union")
    return unionConversion(lowerer, input, from.unionId, to, typeText, loc);
  if (from.kind === "record" && to.kind === "record") {
    const source = lowerer.shapes.get(from.shapeId);
    const target = lowerer.shapes.get(to.shapeId);
    if (
      !source ||
      !target ||
      source.tuple !== target.tuple ||
      source.indexValue ||
      target.indexValue
    )
      return null;
    if (source.fields.length !== target.fields.length) return null;
    const fields: { name: string; value: IrExpr }[] = [];
    for (const field of target.fields) {
      const own = source.fields.find((f) => f.name === field.name);
      if (!own) return null;
      const read: IrExpr = {
        kind: "recordGet",
        obj: input,
        shapeId: from.shapeId,
        field: field.name,
        type: own.type,
        loc,
      };
      const value = converted(lowerer, read, own.type, field.type, loc);
      if (value === null) return null;
      fields.push({
        name: field.name,
        value: keepAbsence(lowerer, input, from.shapeId, field, value, loc),
      });
    }
    // The copy keeps the source's own keys in the source's order, as a width
    // copy does (key-order-witness.ts).
    const copy: IrExpr = { kind: "recordLit", fields, type: to, loc };
    return [{ kind: "return", value: lowerer.keyOrder.copy(copy, from.shapeId), loc }];
  }
  return null;
}

/** A converted field value that keeps the source field's absence: an
 * optional field the source object lacks stays absent in the copy rather
 * than becoming a property that holds undefined. */
function keepAbsence(
  lowerer: Lowerer,
  input: IrExpr,
  shapeId: string,
  field: { name: string; type: IrType },
  value: IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (field.type.kind !== "union") return value;
  if (!lowerer.unions.get(field.type.unionId)?.arms.some((arm) => arm.kind === "undefinedT"))
    return value;
  return {
    kind: "ternary",
    cond: { kind: "recordHas", obj: input, shapeId, field: field.name, type: BOOL, loc },
    then: value,
    else_: { kind: "fieldAbsent", unionId: field.type.unionId, type: field.type, loc },
    type: field.type,
    loc,
  };
}

/** A union value to one of its arms, or to a union of some of its arms:
 * each arm the target holds returns, any other arm throws. */
function unionConversion(
  lowerer: Lowerer,
  input: IrExpr,
  unionId: string,
  to: IrType,
  typeText: string,
  loc: SrcLoc,
): IrStmt[] | null {
  const source = lowerer.unions.get(unionId);
  if (!source) return null;
  const targetArms = to.kind === "union" ? (lowerer.unions.get(to.unionId)?.arms ?? null) : [to];
  if (targetArms === null) return null;
  const body: IrStmt[] = [];
  let kept = 0;
  for (let tag = 0; tag < source.arms.length; tag++) {
    const arm = source.arms[tag]!;
    const targetTag = targetArms.findIndex((t) => typeEquals(t, arm));
    if (targetTag < 0) continue;
    kept++;
    const payload: IrExpr = isUnitType(arm)
      ? { kind: "unitLit", unit: arm.kind === "undefinedT" ? "undefined" : "null", type: arm, loc }
      : { kind: "unionNarrow", unionId, tag, value: input, type: arm, loc };
    const value: IrExpr =
      to.kind === "union"
        ? { kind: "unionWrap", unionId: to.unionId, tag: targetTag, value: payload, type: to, loc }
        : payload;
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId, tag, negated: false, value: input, type: BOOL, loc },
      then: [{ kind: "return", value, loc }],
      else_: null,
      loc,
    });
  }
  // Every arm the target names must be one of the union's own arms.
  if (kept === 0 || kept !== targetArms.length) return null;
  body.push(
    typeError(
      `a kept element is not a '${typeText}' (a type predicate returned true for a value of another type)`,
      loc,
    ),
  );
  return body;
}
