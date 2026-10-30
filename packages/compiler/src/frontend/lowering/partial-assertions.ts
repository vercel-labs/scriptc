/* Partial record assertions (`{ truncated: true } as TruncationResult`).
 *
 * A record literal carries exactly the fields it writes, but its asserted
 * type may require more. Node erases the assertion: the value keeps the
 * literal's properties, and reading a field it never had yields undefined.
 * A record type has a fixed layout, so scriptc keeps the LITERAL's layout
 * (shape A — the written fields and the asserted type's optional fields,
 * these in their absent state, with the asserted type's field types) and
 * hands the asserted type B a PARTIAL record view of it (record-views.ts):
 * the value is a B whose record-source entry names A, and the required B
 * fields A does not declare are absent. Reflection through the view is
 * exact.
 *
 * This module finds those sites and answers, per target shape, which
 * required fields some asserted literal leaves unwritten. The lowering
 * consults it for member reads and writes, destructuring and `in`, so a
 * read of such a field throws the catchable TypeError (Node yields
 * undefined — a documented divergence) instead of reaching a slot the view
 * does not have. Computed once for the whole program, on first use, like
 * the untyped-collection inference (js-collection-types.ts). */

import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { nodeThrowExpr } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrType,
  type SrcLoc,
  UNDEFINED_T,
  VOID,
} from "../../ir/ir.js";

/** One site's facts: the asserted record type, the literal's keys in
 * source order, and the B fields the literal does not write. */
export interface PartialAssertionSite {
  readonly target: IrType & { kind: "record" };
  readonly keys: readonly string[];
  /** The optional B fields the literal does not write, which the literal's
   * layout keeps in their absent state. */
  readonly absent: readonly string[];
  readonly missing: ReadonlySet<string>;
  /** The asserted type's source spelling, for the throw messages. */
  readonly text: string;
}

interface PartialTarget {
  readonly missing: ReadonlySet<string>;
  readonly text: string;
}

const NO_FIELDS: ReadonlySet<string> = new Set();

/** The required fields some asserted literal leaves unwritten on shapes of
 * `shapeId`; empty when no partial assertion produces that shape. */
export function partialAssertionFields(lowerer: Lowerer, shapeId: string): ReadonlySet<string> {
  return partialTargetOf(lowerer, shapeId)?.missing ?? NO_FIELDS;
}

function partialTargetOf(lowerer: Lowerer, shapeId: string): PartialTarget | null {
  if (lowerer.partialAssertions === undefined) {
    const found = new Map<string, PartialTarget>();
    lowerer.partialAssertions = found;
    for (const file of lowerer.program.getImplementationSourceFiles()) {
      if (isJsSourceFile(file)) continue;
      ts.walkPreorder(file, (node) => {
        if (!ts.isAsExpression(node) && !ts.isTypeAssertion(node)) return;
        const site = partialAssertionSite(lowerer, node);
        if (site === null) return;
        const known = found.get(site.target.shapeId);
        const missing = new Set<string>();
        if (known !== undefined) {
          for (const name of known.missing) missing.add(name);
        }
        for (const name of site.missing) missing.add(name);
        found.set(site.target.shapeId, { missing, text: site.text });
      });
    }
  }
  return lowerer.partialAssertions.get(shapeId) ?? null;
}

/** The partial-assertion facts of `expr`, or null when it asserts a record
 * literal to a type that needs no partial view. */
export function partialAssertionSite(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
): PartialAssertionSite | null {
  let operand: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (!ts.isObjectLiteralExpression(operand)) return null;
  const literal: ts.ObjectLiteralExpression = operand;
  const keys: string[] = [];
  for (const prop of literal.properties.nodes) {
    if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) return null;
    const name = prop.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return null;
    // A repeated key is the last write's; the literal alone would not
    // decide the shape. Keys ride the literal's own inferred shape.
    if (keys.includes(name.text)) return null;
    keys.push(name.text);
  }
  const targetTs = lowerer.checker.getTypeFromTypeNode(expr.type);
  const target = lowerer.mapTypeOf(targetTs);
  if (target?.kind !== "record") return null;
  const shape = lowerer.shapes.get(target.shapeId);
  if (!shape || shape.tuple || shape.indexValue !== undefined) return null;
  const missing = new Set<string>();
  for (const key of keys) {
    // A key the asserted type does not declare would ride the overflow
    // map, which a view has no slots for.
    if (!shape.fields.some((f) => f.name === key)) return null;
  }
  const absent: string[] = [];
  for (const field of shape.fields) {
    if (keys.includes(field.name)) continue;
    // An omitted optional field keeps a slot in the literal's layout, in its
    // absent state (lowerPartialAssertion), as an ordinary record of the
    // asserted type does: reads yield undefined, `in` answers false and a
    // write adds the property. Only a required field can be missing.
    if (field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0) {
      absent.push(field.name);
      continue;
    }
    missing.add(field.name);
  }
  if (missing.size === 0) return null;
  return { target, keys, absent, missing, text: lowerer.checker.typeToString(targetTs) };
}

/** The checked read of `field` through a value of `shapeId` that a partial
 * assertion may have produced, or null when the field is always present.
 * `obj` is read twice (the presence test and the read), so it must be safe
 * to repeat. */
export function partialFieldRead(
  lowerer: Lowerer,
  obj: IrExpr,
  shapeId: string,
  field: string,
  fieldType: IrType,
  loc: SrcLoc,
): IrExpr | null {
  const target = partialTargetOf(lowerer, shapeId);
  if (target === null || !target.missing.has(field)) return null;
  return {
    kind: "ternary",
    cond: { kind: "recordHas", obj, shapeId, field, type: BOOL, loc },
    then: { kind: "recordGet", obj, shapeId, field, type: fieldType, loc },
    else_: nodeThrowExpr(
      1,
      "",
      `Cannot read property '${field}': the object asserted as '${target.text}' has no such property`,
      fieldType,
      loc,
    ),
    type: fieldType,
    loc,
  };
}

/** The TypeError a write of a field the asserted literal never wrote
 * throws, or null when the field is always present. */
export function partialFieldWriteError(
  lowerer: Lowerer,
  shapeId: string,
  field: string,
  loc: SrcLoc,
): IrExpr | null {
  const target = partialTargetOf(lowerer, shapeId);
  if (target === null || !target.missing.has(field)) return null;
  return nodeThrowExpr(
    1,
    "",
    `Cannot set property '${field}': the object asserted as '${target.text}' has no such property`,
    VOID,
    loc,
  );
}

/** The own-property presence test for `field` on a receiver of `shapeId`
 * (`"f" in value`), or null when no partial assertion can leave it absent.
 * `obj` must be safe to repeat. */
export function partialFieldPresence(
  lowerer: Lowerer,
  obj: IrExpr,
  shapeId: string,
  field: string,
  loc: SrcLoc,
): IrExpr | null {
  const target = partialTargetOf(lowerer, shapeId);
  if (target === null || !target.missing.has(field)) return null;
  return { kind: "recordHas", obj, shapeId, field, type: BOOL, loc };
}

/** The checked conversion a partial assertion lowers to: the literal built
 * at its OWN layout A (the asserted type's field types, values checked
 * against them), boxed live, and asserted to B as a partial view. */
export function lowerPartialAssertion(
  lowerer: Lowerer,
  expr: ts.AsExpression | ts.TypeAssertion,
  site: PartialAssertionSite,
): IrExpr {
  const loc = locOf(expr);
  let literal: ts.Expression = expr.expression;
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
  const shape = lowerer.shapes.get(site.target.shapeId)!;
  // The site check accepted exactly the literal's property assignments and
  // shorthands, in source order.
  const props = (literal as ts.ObjectLiteralExpression).properties.nodes;
  const fields = site.keys.map((key, i) => {
    const prop = props[i]!;
    const initializer = ts.isPropertyAssignment(prop)
      ? prop.initializer
      : (prop.name as unknown as ts.Expression);
    const type = shape.fields.find((f) => f.name === key)!.type;
    const value = lowerer.coerceInto(prop, lowerer.lowerExprExpecting(initializer, type), type);
    return { name: key, type, value };
  });
  for (const name of site.absent) {
    const type = shape.fields.find((f) => f.name === name)!.type as IrType & { kind: "union" };
    fields.push({
      name,
      type,
      value: { kind: "fieldAbsent", unionId: type.unionId, type, loc },
    });
  }
  // A's identity is its name-sorted field list; its DECLARED order is the
  // literal's, which JSON and Object.keys read through the view's capsule,
  // then the absent optional fields, which a later write appends.
  const shapeId = lowerer.shapes.intern(
    [...fields]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => ({ name: f.name, type: f.type })),
    false,
    undefined,
    [...site.keys, ...site.absent],
  );
  const built: IrExpr = {
    kind: "recordLit",
    fields: fields.map((f) => ({ name: f.name, value: f.value })),
    type: { kind: "record", shapeId },
    loc,
  };
  return {
    kind: "dynCheck",
    partialView: true,
    value: { kind: "dynFrom", value: built, liveRef: true, type: DYN, loc },
    type: site.target,
    loc,
  };
}
