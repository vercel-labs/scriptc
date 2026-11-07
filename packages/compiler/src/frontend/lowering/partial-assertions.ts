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
 * exact, and a write to one of those fields adds the property to the view
 * (the viewed record's extra-property store), so a program that fills a
 * record literal field by field ends with every field it wrote.
 *
 * This module finds those sites and answers, per target shape, which
 * required fields some asserted literal leaves unwritten. The lowering
 * consults it for member reads and `in`, so a read of a field nothing wrote
 * throws the catchable TypeError (Node yields undefined — a documented
 * divergence) instead of reaching a slot the view does not have. Computed
 * once for the whole program, on first use, like the untyped-collection
 * inference (js-collection-types.ts). */

import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { helperLoc, nodeThrowExpr } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
  STRING,
  UNDEFINED_T,
  VOID,
} from "../../ir/ir.js";
import { transformStmtList } from "../../ir/traverse.js";
import { keyedHelperName } from "./stable-names.js";

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
    // An optional checked-dynamic field is absentable too (the absent
    // marker), so an omitted one is absent, not missing.
    if (field.optional === true && field.type.kind === "dyn") {
      absent.push(field.name);
      continue;
    }
    missing.add(field.name);
  }
  if (missing.size === 0) return null;
  return { target, keys, absent, missing, text: lowerer.checker.typeToString(targetTs) };
}

/** The text of the TypeError a read of `field` throws when nothing wrote it. */
function unwrittenReadMessage(field: string, target: PartialTarget): string {
  return `Cannot read property '${field}': the object asserted as '${target.text}' has no such property`;
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
    else_: nodeThrowExpr(1, "", unwrittenReadMessage(field, target), fieldType, loc),
    type: fieldType,
    loc,
  };
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
  // The program has a partial assertion: make sure its targets are known
  // to the passes that run after lowering (guardPartialReads), also when no
  // member read asked for them.
  partialTargetOf(lowerer, site.target.shapeId);
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
    const field = shape.fields.find((f) => f.name === key)!;
    const type = field.type;
    const value = lowerer.coerceInto(prop, lowerer.lowerExprExpecting(initializer, type), type);
    return {
      name: key,
      type,
      value,
      ...(field.optional === true ? { optional: true as const } : {}),
    };
  });
  for (const name of site.absent) {
    const field = shape.fields.find((f) => f.name === name)!;
    const type = field.type;
    fields.push({
      name,
      type,
      value:
        type.kind === "dyn"
          ? { kind: "fieldAbsent", type, loc }
          : {
              kind: "fieldAbsent",
              unionId: (type as IrType & { kind: "union" }).unionId,
              type,
              loc,
            },
      ...(field.optional === true ? { optional: true as const } : {}),
    });
  }
  // A's identity is its name-sorted field list; its DECLARED order is the
  // literal's, which JSON and Object.keys read through the view's capsule,
  // then the absent optional fields, which a later write appends.
  const shapeId = lowerer.shapes.intern(
    [...fields]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.optional === true ? { optional: true as const } : {}),
      })),
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

/** Interned `%partial.read.<n>(r, k)` (`keyed`) or `%partial.whole.<n>(r)`:
 * throws the read rule's TypeError for the property `k` names, or for the
 * first property in declaration order, when a partial assertion left it
 * unwritten and nothing wrote it since. Answers nothing otherwise. */
function unwrittenReadCheck(
  lowerer: Lowerer,
  shapeId: string,
  target: PartialTarget,
  keyed: boolean,
  loc: SrcLoc,
): string {
  const key = `partial.${keyed ? "read" : "whole"}:${shapeId}`;
  const existing = lowerer.arrHofHelpers.get(key);
  if (existing) return existing;
  const helper = keyedHelperName(lowerer, keyed ? "%partial.read" : "%partial.whole", key);
  lowerer.arrHofHelpers.set(key, helper);
  const at = helperLoc(loc);
  const recT: IrType = { kind: "record", shapeId };
  const rRef: IrExpr = { kind: "varRef", localId: "r.0", type: recT, loc: at };
  const kRef: IrExpr = { kind: "varRef", localId: "k.0", type: STRING, loc: at };
  const body: IrStmt[] = [];
  for (const field of lowerer.shapes.get(shapeId)?.fields ?? []) {
    if (!target.missing.has(field.name)) continue;
    const refuse: IrStmt = {
      kind: "if",
      cond: {
        kind: "unary",
        op: "!",
        operand: { kind: "recordHas", obj: rRef, shapeId, field: field.name, type: BOOL, loc: at },
        type: BOOL,
        loc: at,
      },
      then: [
        {
          kind: "exprStmt",
          expr: nodeThrowExpr(1, "", unwrittenReadMessage(field.name, target), VOID, at),
          loc: at,
        },
        { kind: "return", value: null, loc: at },
      ],
      else_: null,
      loc: at,
    };
    if (!keyed) {
      body.push(refuse);
      continue;
    }
    body.push({
      kind: "if",
      cond: {
        kind: "strEq",
        negated: false,
        left: kRef,
        right: { kind: "strLit", value: field.name, type: STRING, loc: at },
        type: BOOL,
        loc: at,
      },
      then: [refuse, { kind: "return", value: null, loc: at }],
      else_: null,
      loc: at,
    });
  }
  body.push({ kind: "return", value: null, loc: at });
  const fn: IrFunction = {
    name: helper,
    params: [
      { localId: "r.0", name: "r", type: recT },
      ...(keyed ? [{ localId: "k.0", name: "k", type: STRING }] : []),
    ],
    returnType: VOID,
    locals: [
      { id: "r.0", name: "r", type: recT, mutable: false },
      ...(keyed ? [{ id: "k.0", name: "k", type: STRING, mutable: false }] : []),
    ],
    body,
    loc: at,
  };
  lowerer.liftedFns.push(fn);
  return helper;
}

/** Brings every read of a record type some partial assertion produces under
 * the one read rule (partialFieldRead), also the reads the lowering does
 * not spell as a member read: a computed-key read `r[k]`, the per-key
 * dispatch of `r[k] ??= v` and `r[k] += v`, a spread `{ ...r }`, a
 * destructuring. Without the check the backend reaches a property the view
 * does not have and stops the program (record-views.ts
 * PARTIAL_VIEW_ABSENT); with it the read throws the same catchable
 * TypeError as `r.k`. A spread reads every property, so it throws for the
 * first one still unwritten. Programs without a partial assertion are not
 * walked. */
export function guardPartialReads(lowerer: Lowerer, functions: IrFunction[]): void {
  const targets = lowerer.partialAssertions;
  if (targets === undefined || targets.size === 0) return;
  const lifted = lowerer.liftedFns.length;
  const partial = (type: IrType): PartialTarget | null => {
    if (type.kind !== "record") return null;
    const target = targets.get(type.shapeId);
    return target !== undefined && target.missing.size > 0 ? target : null;
  };
  for (const fn of functions) {
    const local = (type: IrType, loc: SrcLoc): Extract<IrExpr, { kind: "varRef" }> => {
      const id = `%partialRead.${fn.locals.length}`;
      fn.locals.push({ id, name: id, type, mutable: false });
      return { kind: "varRef", localId: id, type, loc };
    };
    const checked = new Set<IrExpr>();
    fn.body = transformStmtList(fn.body, {
      stmt: (statement) => statement,
      expr: (e) => {
        if (checked.has(e)) return e;
        // The lowering's own checked read (partialFieldRead): its read is
        // behind the presence test already.
        if (
          e.kind === "ternary" &&
          e.cond.kind === "recordHas" &&
          e.then.kind === "recordGet" &&
          e.then.shapeId === e.cond.shapeId &&
          e.then.field === e.cond.field
        ) {
          checked.add(e.then);
          return e;
        }
        // Any other field read of a property an assertion may have left
        // unwritten: the per-key dispatch of a compound keyed write, a
        // spread that reads every field into a new record, a destructuring.
        if (e.kind === "recordGet") {
          const target = targets.get(e.shapeId);
          if (target === undefined || !target.missing.has(e.field)) return e;
          const loc = e.loc;
          const obj = local(e.obj.type, loc);
          const read: IrExpr = { ...e, obj };
          checked.add(read);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "varDecl", localId: obj.localId, init: e.obj, loc }],
            result: {
              kind: "ternary",
              cond: { kind: "recordHas", obj, shapeId: e.shapeId, field: e.field, type: BOOL, loc },
              then: read,
              else_: nodeThrowExpr(1, "", unwrittenReadMessage(e.field, target), e.type, loc),
              type: e.type,
              loc,
            },
            type: e.type,
            loc,
          };
        }
        if (e.kind === "recordKeyGet" && e.overflowOnly !== true && e.key.type.kind === "string") {
          const target = partial(e.obj.type);
          if (target === null || e.obj.type.kind !== "record" || e.obj.type.shapeId !== e.shapeId)
            return e;
          const loc = e.loc;
          const obj = local(e.obj.type, loc);
          const key = local(e.key.type, loc);
          const read: IrExpr = { ...e, obj, key };
          checked.add(read);
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: obj.localId, init: e.obj, loc },
              { kind: "varDecl", localId: key.localId, init: e.key, loc },
              {
                kind: "exprStmt",
                expr: {
                  kind: "call",
                  callee: unwrittenReadCheck(lowerer, e.shapeId, target, true, loc),
                  args: [obj, key],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ],
            result: read,
            type: e.type,
            loc,
          };
        }
        if (e.kind === "recordClone") {
          const target = partial(e.source.type);
          if (target === null || e.source.type.kind !== "record") return e;
          const loc = e.loc;
          const source = local(e.source.type, loc);
          const clone: IrExpr = { ...e, source };
          checked.add(clone);
          return {
            kind: "seqExpr",
            stmts: [
              { kind: "varDecl", localId: source.localId, init: e.source, loc },
              {
                kind: "exprStmt",
                expr: {
                  kind: "call",
                  callee: unwrittenReadCheck(lowerer, e.source.type.shapeId, target, false, loc),
                  args: [source],
                  type: VOID,
                  loc,
                },
                loc,
              },
            ],
            result: clone,
            type: e.type,
            loc,
          };
        }
        return e;
      },
    });
  }
  for (const helper of lowerer.liftedFns.slice(lifted)) functions.push(helper);
}
