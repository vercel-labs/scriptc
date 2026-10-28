import { fieldOrigin } from "../decl-origin.js";
import { keyedHelperName } from "../stable-names.js";
import { constructedValue } from "../constructor-returns.js";
import { countedFor, dynUndefinedExpr, varRef } from "../../../ir/build.js";
import type { FieldLift } from "./structural-plans.js";
import { buildArrayConversion } from "./builders.js";
import { arrayValueRead, arrayValueStore, primitiveElement } from "../array-values.js";
import type { WidthLift } from "../width-lift.js";
import { InternalCompilerError } from "../../../errors.js";
import type { IrExpr, IrFunction, IrRecordShape, IrStmt, IrType, SrcLoc } from "../../../ir/ir.js";
import { BOOL, DYN, F64, STRING, UNDEFINED_T, isUnitType, typeEquals } from "../../../ir/ir.js";
import { typeKey } from "../../type-mapper.js";
import { findStaticOn, findGenericStaticOn } from "../lower-classes.js";
import { lowerRecordOvfCaptureHelper } from "../containers/indexed-objects.js";
import type { Lowerer } from "../lowerer.js";

/** Convert structural values by copying their supported fields or elements.
 * Unlike JavaScript width subtyping, these conversions create fresh storage
 * (SEMANTICS.md). Decline pairs with no validated conversion. */
export function widthCoerce(lowerer: Lowerer, expr: IrExpr, expected: IrType): IrExpr | null {
  if (expected.kind === "record" && expr.type.kind === "record") {
    // Index-signature pairs reshape through the overflow CAPTURE helper
    // (the `Object.fromEntries(e) as ModelPricing` pattern — declared
    // collisions validate at runtime); plain shapes keep the field-copy
    // width helper. Each declines the other's shapes.
    const helper =
      lowerer.recordWidthHelper(expr.type.shapeId, expected.shapeId, expr.loc) ??
      lowerRecordOvfCaptureHelper(lowerer, expr.type.shapeId, expected.shapeId, expr.loc);
    if (!helper) return null;
    return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
  }
  // A CLASS INSTANCE flowing into a record slot (`new Point(0, 0)` into
  // `{ x: number; y: number }` — tsc's structural view of classes): the
  // same field-projecting copy, each target field read off the instance.
  if (expected.kind === "record" && expr.type.kind === "object") {
    const helper = lowerer.objRecordWidthHelper(expr.type.className, expected.shapeId, expr.loc);
    if (!helper) return null;
    return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
  }
  // A RECORD flowing into a class-instance slot (`{x: 0, y: 0}` into
  // `A.Point` — the parameter-property data-class pattern): construction
  // IS the projection when the constructor is nothing but parameter
  // properties (recordToClassPlan's gates).
  if (expected.kind === "object" && expr.type.kind === "record") {
    const helper = lowerer.recordClassWidthHelper(expr.type.shapeId, expected.className, expr.loc);
    if (!helper) return null;
    return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
  }
  // A CLASS VALUE flowing into a record slot (`var f: ShapeFactory =
  // Shape` — an interface matched by the class's STATIC side): the
  // record captures the statics — fields as copies, methods as the
  // zero-capture closures `const f = C.m` builds. Direct classRef
  // sources only: the projection reads no runtime value, so an effectful
  // source expression would lose its evaluation.
  if (expected.kind === "record" && expr.type.kind === "classval" && expr.kind === "classRef") {
    return lowerer.classStaticsProjection(expr.type.className, expected.shapeId, expr.loc);
  }
  if (expected.kind === "array" && expr.type.kind === "array") {
    const optional = optionalArrayHelper(lowerer, expr.type, expected, expr.loc);
    if (optional)
      return { kind: "call", callee: optional, args: [expr], type: expected, loc: expr.loc };
    const helper = lowerer.arrayWidthHelper(expr.type, expected, expr.loc);
    if (helper)
      return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
    // The EMPTY-array lift (widthLiftPlan's emptyArr rule), top-level:
    // `cmd.aliases` typed `(null | undefined)[]` (an `aliases: []`
    // table) flowing into a `string[]` slot.
    const lift = lowerer.widthLiftPlan(expr.type, expected);
    if (lift?.how !== "emptyArr") return null;
    return lowerer.applyWidthLift(lift, expr, expected, expr.loc);
  }
  // A TUPLE flowing into an array slot (`const NAMES = [...] as const`
  // assigned to a `readonly T[]` — the const-table pattern): TS erases
  // the arity without a conversion; the monomorphic tuple REBUILDS as a
  // fresh array, each position's value lifted into the element type (the
  // same copy stance as every width coercion — later mutations don't alias).
  if (expected.kind === "array" && expr.type.kind === "record") {
    const helper = lowerer.tupleArrayWidthHelper(expr.type.shapeId, expected, expr.loc);
    if (!helper) return null;
    return { kind: "call", callee: helper, args: [expr], type: expected, loc: expr.loc };
  }

  // element (the messages-array pattern — records holding `any` content).
  return null;
}

/** The build side of widthLiftPlan: the IrExpr converting `value` into
 * `dst` under a plan the caller validated. Interns whatever helpers the
 * lift needs (planned first, so the interns cannot fail — a failure here
 * is a lowerer bug, not a user diagnostic). */
export function applyWidthLift(
  lowerer: Lowerer,
  lift: WidthLift,
  value: IrExpr,
  dst: IrType,
  loc: SrcLoc,
): IrExpr {
  switch (lift.how) {
    case "copy":
      return value;
    case "wrap": {
      if (dst.kind !== "union")
        throw new InternalCompilerError("lowerer bug: wrap lift against a non-union");
      return { kind: "unionWrap", unionId: dst.unionId, tag: lift.tag, value, type: dst, loc };
    }
    case "discriminantWrap": {
      if (dst.kind !== "union" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: record discriminator lift shape");
      const helper = lowerer.recordUnionWrapHelper(value.type, dst.unionId, loc);
      if (!helper)
        throw new InternalCompilerError(
          "lowerer bug: planned record discriminator lift failed to intern",
        );
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "discriminantRoute": {
      if (dst.kind !== "union" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: record discriminant route shape");
      const helper = lowerer.recordUnionRouteHelper(value.type, dst.unionId, loc);
      if (!helper)
        throw new InternalCompilerError(
          "lowerer bug: planned record discriminant route failed to intern",
        );
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "retag": {
      if (dst.kind !== "union" || value.type.kind !== "union")
        throw new InternalCompilerError("lowerer bug: retag lift shape");
      const retag = lowerer.unionRetagHelper(value.type.unionId, dst.unionId, loc);
      if (!retag)
        throw new InternalCompilerError("lowerer bug: planned retag lift failed to intern");
      return { kind: "call", callee: retag, args: [value], type: dst, loc };
    }
    case "unitRetag": {
      if (dst.kind !== "union" || value.type.kind !== "union")
        throw new InternalCompilerError("lowerer bug: unit retag lift shape");
      const fromId = value.type.unionId;
      const trappable = new Set<number>();
      (lowerer.unions.get(fromId)?.arms ?? []).forEach((arm, tag) => {
        if (lowerer.armTag(dst.unionId, arm) < 0) trappable.add(tag);
      });
      const retag = lowerer.unionRetagHelper(fromId, dst.unionId, loc, trappable);
      if (!retag)
        throw new InternalCompilerError("lowerer bug: planned unit retag lift failed to intern");
      return { kind: "call", callee: retag, args: [value], type: dst, loc };
    }
    case "liftWrap": {
      if (dst.kind !== "union")
        throw new InternalCompilerError("lowerer bug: liftWrap lift against a non-union");
      const inner = lowerer.widthLiftPlan(value.type, lift.arm);
      if (!inner)
        throw new InternalCompilerError("lowerer bug: planned liftWrap arm stopped lifting");
      const lifted = lowerer.applyWidthLift(inner, value, lift.arm, loc);
      return {
        kind: "unionWrap",
        unionId: dst.unionId,
        tag: lift.tag,
        value: lifted,
        type: dst,
        loc,
      };
    }
    case "presenceRoute": {
      if (dst.kind !== "union" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: presenceRoute lift shape");
      const sourceType = value.type;
      const fieldType = lowerer.shapes
        .get(sourceType.shapeId)
        ?.fields.find((f) => f.name === lift.field)?.type;
      if (fieldType?.kind !== "union")
        throw new InternalCompilerError("lowerer bug: presenceRoute field shape");
      // One helper per pair: the conversion reads the source twice.
      const key = `presence:${typeKey(sourceType)}:${dst.unionId}:${lift.field}`;
      let helper = lowerer.valueHelpers.get(key);
      if (!helper) {
        helper = `%union.presence.${lowerer.valueHelpers.size}`;
        lowerer.valueHelpers.set(key, helper);
        const source = (): IrExpr => varRef("v.0", sourceType, loc);
        const arm = (route: { tag: number; arm: IrType }): IrExpr => {
          const inner = lowerer.widthLiftPlan(sourceType, route.arm);
          if (!inner)
            throw new InternalCompilerError(
              "lowerer bug: planned presenceRoute arm stopped lifting",
            );
          return {
            kind: "unionWrap",
            unionId: dst.unionId,
            tag: route.tag,
            value: lowerer.applyWidthLift(inner, source(), route.arm, loc),
            type: dst,
            loc,
          };
        };
        lowerer.liftedFns.push({
          name: helper,
          params: [{ localId: "v.0", name: "v", type: sourceType }],
          returnType: dst,
          locals: [{ id: "v.0", name: "v", type: sourceType, mutable: false }],
          body: [
            {
              kind: "return",
              value: {
                kind: "ternary",
                cond: {
                  kind: "unionIsTag",
                  unionId: fieldType.unionId,
                  tag: lowerer.armTag(fieldType.unionId, UNDEFINED_T),
                  value: {
                    kind: "recordGet",
                    obj: source(),
                    shapeId: sourceType.shapeId,
                    field: lift.field,
                    type: fieldType,
                    loc,
                  },
                  negated: false,
                  type: BOOL,
                  loc,
                },
                then: arm(lift.absent),
                else_: arm(lift.present),
                type: dst,
                loc,
              },
              loc,
            },
          ],
          loc,
        });
      }
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "width": {
      if (dst.kind !== "record" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: width lift shape");
      const helper = lowerer.recordWidthHelper(value.type.shapeId, dst.shapeId, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned width lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "ovf": {
      if (dst.kind !== "record" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: ovf lift shape");
      const helper = lowerRecordOvfCaptureHelper(lowerer, value.type.shapeId, dst.shapeId, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned ovf lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "unionWidth": {
      if (dst.kind !== "record" || value.type.kind !== "union")
        throw new InternalCompilerError("lowerer bug: union width lift shape");
      const helper = lowerer.unionRecordWidthHelper(value.type.unionId, dst, loc);
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "unionArr": {
      if (dst.kind !== "array" || value.type.kind !== "union")
        throw new InternalCompilerError("lowerer bug: union array lift shape");
      const helper = lowerer.unionArrayWidthHelper(value.type.unionId, dst, loc);
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "arr": {
      if (dst.kind !== "array" || value.type.kind !== "array")
        throw new InternalCompilerError("lowerer bug: arr lift shape");
      const helper = lowerer.arrayWidthHelper(value.type, dst, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned arr lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "tupleArr": {
      if (dst.kind !== "array" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: tupleArr lift shape");
      const helper = lowerer.tupleArrayWidthHelper(value.type.shapeId, dst, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned tupleArr lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "emptyArr": {
      if (dst.kind !== "array" || value.type.kind !== "array")
        throw new InternalCompilerError("lowerer bug: emptyArr lift shape");
      const helper = lowerer.emptyArrayLiftHelper(value.type, dst, loc);
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "objWidth": {
      if (dst.kind !== "record" || value.type.kind !== "object")
        throw new InternalCompilerError("lowerer bug: objWidth lift shape");
      const helper = lowerer.objRecordWidthHelper(value.type.className, dst.shapeId, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned objWidth lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "clsWidth": {
      if (dst.kind !== "object" || value.type.kind !== "record")
        throw new InternalCompilerError("lowerer bug: clsWidth lift shape");
      const helper = lowerer.recordClassWidthHelper(value.type.shapeId, dst.className, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned clsWidth lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "narrow": {
      if (value.type.kind !== "union")
        throw new InternalCompilerError("lowerer bug: narrow lift on a non-union");
      const helper = lowerer.narrowedArmHelper(value.type.unionId, dst, loc);
      if (!helper)
        throw new InternalCompilerError("lowerer bug: planned narrow lift failed to intern");
      return { kind: "call", callee: helper, args: [value], type: dst, loc };
    }
    case "dynIn": {
      if (dst.kind !== "dyn")
        throw new InternalCompilerError("lowerer bug: dynIn lift against a non-dyn slot");
      // The declaration-typed boundary keeps user values' identity when
      // they cross into package code (decl-projection.ts).
      if (
        lowerer.declBoundary &&
        !/[\\/]node_modules[\\/]/.test(loc.file) &&
        liveBoxable(lowerer, value.type)
      )
        return { kind: "dynFrom", value, liveRef: true, type: DYN, loc };
      return { kind: "dynFrom", value, type: DYN, loc };
    }
    case "dynOut":
      return { kind: "dynCheck", value, type: dst, loc };
    case "upcast": {
      if (dst.kind !== "object" || value.type.kind !== "object")
        throw new InternalCompilerError("lowerer bug: upcast lift shape");
      return lowerer.upcastTo(value, dst.className);
    }
    case "funcAdapt": {
      if (dst.kind !== "func" || value.type.kind !== "func")
        throw new InternalCompilerError("lowerer bug: funcAdapt lift shape");
      const adapter = lowerer.funcCoerceAdapter(value.type, dst, loc);
      if (!adapter)
        throw new InternalCompilerError("lowerer bug: planned funcAdapt lift failed to intern");
      return { kind: "call", callee: adapter, args: [value], type: dst, loc };
    }
    case "promiseWiden": {
      if (dst.kind !== "promise" || value.type.kind !== "promise")
        throw new InternalCompilerError("lowerer bug: promiseWiden lift shape");
      const converted = lowerer.coerceToExpected(value, dst);
      if (!typeEquals(converted.type, dst))
        throw new InternalCompilerError(
          "lowerer bug: planned promise payload widening stopped converting",
        );
      return converted;
    }
    default: {
      const _exhaustive: never = lift;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** Dispatch a structural copy from its runtime union tag. Each record
 * payload has its own field offsets and optional-field completions;
 * interpreting all arms as the destination layout would corrupt memory.
 * Intern before descending so recursive record unions can reuse it. */
export function unionRecordWidthHelper(
  lowerer: Lowerer,
  fromId: string,
  target: IrType & { kind: "record" },
  loc: SrcLoc,
): string {
  const key = `unionWidth:${fromId}:${target.shapeId}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%union.record", key);
  lowerer.valueHelpers.set(key, name);
  const type: IrType = { kind: "union", unionId: fromId };
  const value = varRef("value.0", type, loc);
  const from = lowerer.unions.get(fromId);
  if (!from) throw new InternalCompilerError("lowerer bug: missing record union");
  const body: IrStmt[] = [];
  from.arms.forEach((arm, tag) => {
    const lift = lowerer.widthLiftPlan(arm, target);
    if (!lift || arm.kind !== "record")
      throw new InternalCompilerError("lowerer bug: invalid union record plan");
    const narrowed: IrExpr = { kind: "unionNarrow", unionId: fromId, tag, value, type: arm, loc };
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId: fromId, tag, negated: false, value, type: BOOL, loc },
      then: [{ kind: "return", value: lowerer.applyWidthLift(lift, narrowed, target, loc), loc }],
      else_: null,
      loc,
    });
  });
  body.push({
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [{ kind: "strLit", value: "invalid record union tag", type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  });
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "value.0", name: "value", type }],
    returnType: target,
    locals: [{ id: "value.0", name: "value", type, mutable: false }],
    body,
    loc,
  });
  return name;
}

/** Dispatch a union of tuples/arrays into one array slot from its runtime
 * tag (widthLiftPlan's unionArr): each arm rebuilds or copies on its own
 * tag through the ordinary width lifts, the same copy stance
 * tupleArrayWidthHelper takes for one tuple. A unit arm takes the stranded
 * TypeError: the slot holds no unit, the checker excluded that arm, and
 * only a lying `!`/assertion still carries it. Intern before descending so
 * a recursive arm lift can reuse it. */
export function unionArrayWidthHelper(
  lowerer: Lowerer,
  fromId: string,
  target: IrType & { kind: "array" },
  loc: SrcLoc,
): string {
  const key = `unionArr:${fromId}:${typeKey(target)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%union.arr", key);
  lowerer.valueHelpers.set(key, name);
  const type: IrType = { kind: "union", unionId: fromId };
  const value = varRef("value.0", type, loc);
  const from = lowerer.unions.get(fromId);
  if (!from) throw new InternalCompilerError("lowerer bug: missing array union");
  const body: IrStmt[] = [];
  for (let tag = 0; tag < from.arms.length; tag++) {
    const arm = from.arms[tag]!;
    const then: IrStmt[] = [];
    if (isUnitType(arm)) {
      const what = arm.kind === "nullT" ? "null" : "undefined";
      then.push({
        kind: "throw",
        value: {
          kind: "libCall",
          fn: "error.new",
          args: [
            {
              kind: "strLit",
              value: `${what} is not representable in a '${lowerer.fmt(target)}' slot (a value narrowed or asserted past the type still held it)`,
              type: STRING,
              loc,
            },
          ],
          type: { kind: "object", className: "%TypeError" },
          loc,
        },
        loc,
      });
    } else {
      const lift = lowerer.widthLiftPlan(arm, target);
      if (!lift) throw new InternalCompilerError("lowerer bug: invalid union array plan");
      const narrowed: IrExpr = { kind: "unionNarrow", unionId: fromId, tag, value, type: arm, loc };
      then.push({
        kind: "return",
        value: lowerer.applyWidthLift(lift, narrowed, target, loc),
        loc,
      });
    }
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId: fromId, tag, negated: false, value, type: BOOL, loc },
      then,
      else_: null,
      loc,
    });
  }
  body.push({
    kind: "throw",
    value: {
      kind: "libCall",
      fn: "error.new",
      args: [{ kind: "strLit", value: "invalid array union tag", type: STRING, loc }],
      type: { kind: "object", className: "%TypeError" },
      loc,
    },
    loc,
  });
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "value.0", name: "value", type }],
    returnType: target,
    locals: [{ id: "value.0", name: "value", type, mutable: false }],
    body,
    loc,
  });
  return name;
}

export function recordWidthHelper(
  lowerer: Lowerer,
  fromId: string,
  toId: string,
  loc: SrcLoc,
): string | null {
  const from = lowerer.shapes.get(fromId);
  const to = lowerer.shapes.get(toId);
  if (!from || !to) return null;
  // Plan every target field BEFORE interning anything (interned helpers
  // are part of the emitted program; a later field's failure must not
  // orphan one).
  const plan = lowerer.recordWidthPlan(fromId, toId);
  if (!plan) return null;
  // Package code converting into a package-declared record type (an
  // object literal returned under `@returns {HelpContext}`): its field
  // extractions name the declared fields (decl-origin.ts), so the helper
  // is keyed by that type's declaration too (two packages may declare
  // records of the same name and shape). Every other projection is shared
  // as before.
  const declared = lowerer.coercionRecordOrigin();
  const key =
    declared === null ? `rec:${fromId}:${toId}` : `rec:${fromId}:${toId}:origin:${declared.key}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%rec.width", key);
  // Interned BEFORE the body builds: a recursive nested-width field
  // (self-referential shapes) resolves to this helper itself.
  lowerer.valueHelpers.set(key, name);
  const fromT: IrType = { kind: "record", shapeId: fromId };
  const outerNode = lowerer.coercionOriginNode;
  const outerField = lowerer.coercionFieldOrigin;
  // Nested conversions see only their own field's origin.
  lowerer.coercionOriginNode = null;
  lowerer.coercionFieldOrigin = null;
  try {
    lowerer.liftedFns.push(
      buildRecordProjection(lowerer, name, fromT, to, plan, loc, (field) =>
        declared === null ? null : fieldOrigin(lowerer.checker, declared, field),
      ),
    );
  } finally {
    lowerer.coercionOriginNode = outerNode;
    lowerer.coercionFieldOrigin = outerField;
  }
  return name;
}

/** Rebuild a tuple as an array in numeric field order, applying a validated
 * conversion at each position. Named records do not convert to arrays. */
export function tupleArrayWidthHelper(
  lowerer: Lowerer,
  fromId: string,
  toT: IrType & { kind: "array" },
  loc: SrcLoc,
): string | null {
  const from = lowerer.shapes.get(fromId);
  if (!from || !from.tuple) return null;
  const fields = [...from.fields].sort((a, b) => Number(a.name) - Number(b.name));
  const lifts: WidthLift[] = [];
  for (const f of fields) {
    const lift = lowerer.widthLiftPlan(f.type, toT.elem);
    if (!lift) return null;
    lifts.push(lift);
  }
  const key = `tuparr:${fromId}:${typeKey(toT.elem)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%tup.arr", key);
  lowerer.valueHelpers.set(key, name);
  const fromT: IrType = { kind: "record", shapeId: fromId };
  const t: IrExpr = { kind: "varRef", localId: "t.0", type: fromT, loc };
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "t.0", name: "t", type: fromT }],
    returnType: toT,
    locals: [{ id: "t.0", name: "t", type: fromT, mutable: true }],
    body: [
      {
        kind: "return",
        value: {
          kind: "arrayLit",
          elems: fields.map((f, i) =>
            lowerer.applyWidthLift(
              lifts[i]!,
              { kind: "recordGet", obj: t, shapeId: fromId, field: f.name, type: f.type, loc },
              toT.elem,
              loc,
            ),
          ),
          type: toT,
          loc,
        },
        loc,
      },
    ],
    loc,
  });
  return name;
}

/** Interned `%arr.empty.<n>(a)` — the EMPTY-array lift's build side: a
 * unit-only-element array reshapes into any data-element array by
 * answering a FRESH empty array, after a runtime non-empty trap (a
 * genuinely inhabited `(null | undefined)[]` cannot reshape — the
 * catchable-TypeError stance every checked extraction takes). */
export function emptyArrayLiftHelper(
  lowerer: Lowerer,
  fromT: IrType & { kind: "array" },
  toT: IrType & { kind: "array" },
  loc: SrcLoc,
): string {
  const key = `emptyarr:${typeKey(fromT.elem)}:${typeKey(toT.elem)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.empty", key);
  lowerer.valueHelpers.set(key, name);
  const a: IrExpr = { kind: "varRef", localId: "a.0", type: fromT, loc };
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "a.0", name: "a", type: fromT }],
    returnType: toT,
    locals: [{ id: "a.0", name: "a", type: fromT, mutable: true }],
    body: [
      {
        kind: "if",
        cond: {
          kind: "bin",
          op: "!==",
          left: { kind: "arrIntrinsic", method: "length", receiver: a, args: [], type: F64, loc },
          right: { kind: "numLit", value: 0, type: F64, loc },
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "throw",
            value: {
              kind: "libCall",
              fn: "error.new",
              args: [
                {
                  kind: "strLit",
                  value: `expected ${lowerer.fmt(toT)} (a non-empty ${lowerer.fmt(fromT)} has no elements the target can hold)`,
                  type: STRING,
                  loc,
                },
              ],
              type: { kind: "object", className: "%TypeError" },
              loc,
            },
            loc,
          },
        ],
        else_: [],
        loc,
      },
      { kind: "return", value: { kind: "arrayLit", elems: [], type: toT, loc }, loc },
    ],
    loc,
  });
  return name;
}

/** Copy an array of `T | undefined` unions (a collection's values, an
 * iterator drain) into a `(T | undefined)[]` of a number, string or
 * boolean T, which stores T elements: undefined values become present
 * undefined elements. Null for other element types. */
function optionalArrayHelper(
  lowerer: Lowerer,
  fromT: IrType & { kind: "array" },
  toT: IrType & { kind: "array" },
  loc: SrcLoc,
): string | null {
  const from = fromT.elem;
  const to = toT.elem;
  if (
    !primitiveElement(to) ||
    from.kind !== "union" ||
    lowerer.armTag(from.unionId, UNDEFINED_T) < 0 ||
    !typeEquals(lowerer.stripUndefinedArm(from), to)
  )
    return null;
  const key = `arrOptional:${typeKey(from)}:${typeKey(to)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.width", key);
  lowerer.valueHelpers.set(key, name);
  const input = varRef("a.0", fromT, loc);
  const out = varRef("out.0", toT, loc);
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "a.0", name: "a", type: fromT }],
    returnType: toT,
    locals: [
      { id: "a.0", name: "a", type: fromT, mutable: true },
      { id: "out.0", name: "out", type: toT, mutable: false },
      { id: "i.0", name: "i", type: F64, mutable: true },
      { id: "v.0", name: "v", type: from, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "out.0",
        init: { kind: "arrayLit", elems: [], type: toT, loc },
        loc,
      },
      countedFor(
        loc,
        { kind: "arrIntrinsic", method: "length", receiver: input, args: [], type: F64, loc },
        (index) => [
          {
            kind: "varDecl",
            localId: "v.0",
            init: arrayValueRead(lowerer, input, index, from, loc),
            loc,
          },
          arrayValueStore(lowerer, out, index, varRef("v.0", from, loc), to, loc),
        ],
      ),
      { kind: "return", value: out, loc },
    ],
    loc,
  });
  return name;
}

/** Copy an array through its validated element conversion. Intern before
 * building the body so recursive element conversions can reuse this helper. */
export function arrayWidthHelper(
  lowerer: Lowerer,
  fromT: IrType & { kind: "array" },
  toT: IrType & { kind: "array" },
  loc: SrcLoc,
): string | null {
  const fromElem = fromT.elem;
  const toElem = toT.elem;
  const elemLift = lowerer.widthLiftPlan(fromElem, toElem);
  if (!elemLift || elemLift.how === "copy") return null;
  const key = `arr:${typeKey(fromElem)}:${typeKey(toElem)}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%arr.width", key);
  lowerer.valueHelpers.set(key, name);
  const arrT: IrType = { kind: "array", elem: fromElem };
  const outT: IrType = { kind: "array", elem: toElem };
  lowerer.liftedFns.push(
    buildArrayConversion(
      name,
      arrT,
      { kind: "arrayLit", elems: [], type: outT, loc },
      (element, index, result) => {
        let value = lowerer.applyWidthLift(elemLift, element, toElem, loc);
        // A number, string or boolean array can hold present undefined
        // elements (`(T | undefined)[]` stores T): they, and holes, copy
        // as the target's undefined.
        const missing = primitiveElement(fromElem) ? lowerer.wrappedUndefined(toElem, loc) : null;
        if (missing !== null)
          value = {
            kind: "ternary",
            cond: {
              kind: "bin",
              op: "===",
              left: { kind: "arrayState", arr: varRef("a.0", arrT, loc), index, type: F64, loc },
              right: { kind: "numLit", value: 1, type: F64, loc },
              type: BOOL,
              loc,
            },
            then: value,
            else_: missing,
            type: toElem,
            loc,
          };
        return {
          kind: "arrIntrinsic",
          method: "push",
          receiver: result,
          args: [value],
          type: F64,
          loc,
        };
      },
      loc,
    ),
  );
  return name;
}

/** Interned `%obj.width.<n>(o)` — builds a record from a class
 * instance's fields under objToRecordPlan: the width-copy stance
 * (divergence 305 — a fresh record, mutations don't alias, extra class
 * members drop). */
export function objRecordWidthHelper(
  lowerer: Lowerer,
  className: string,
  toId: string,
  loc: SrcLoc,
): string | null {
  const to = lowerer.shapes.get(toId);
  if (!to) return null;
  const plan = lowerer.objToRecordPlan(className, toId);
  if (!plan) return null;
  const key = `obj:${className}:${toId}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%obj.width", key);
  lowerer.valueHelpers.set(key, name);
  const fromT: IrType = { kind: "object", className };
  lowerer.liftedFns.push(buildRecordProjection(lowerer, name, fromT, to, plan, loc));
  return name;
}

/** Interned `%cls.width.<n>(r)` — `new C(r.p1, ..., r.pn)` under
 * recordToClassPlan: the record's fields become the trivial
 * constructor's arguments (divergence 305's copy stance — a fresh
 * instance, mutations don't alias, and `instanceof C` answers true
 * where Node's plain object answers false). */
export function recordClassWidthHelper(
  lowerer: Lowerer,
  fromId: string,
  className: string,
  loc: SrcLoc,
): string | null {
  const info = lowerer.classes.get(className);
  if (!info) return null;
  const plan = lowerer.recordToClassPlan(fromId, className);
  if (!plan) return null;
  const key = `cls:${fromId}:${className}`;
  const existing = lowerer.valueHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%cls.width", key);
  lowerer.valueHelpers.set(key, name);
  lowerer.noteEdge(`%${className}.constructor`);
  const fromT: IrType = { kind: "record", shapeId: fromId };
  const toT: IrType = { kind: "object", className };
  const r: IrExpr = { kind: "varRef", localId: "r.0", type: fromT, loc };
  const args = plan.map((entry, i): IrExpr => {
    const shape = info.ctorParams[i]!;
    if ("absent" in entry) {
      const u = lowerer.wrappedUndefined(shape.type, loc);
      if (!u)
        throw new InternalCompilerError(
          "lowerer bug: planned absent ctor arg has no undefined arm",
        );
      return u;
    }
    const get: IrExpr = {
      kind: "recordGet",
      obj: r,
      shapeId: fromId,
      field: entry.field,
      type: entry.src,
      loc,
    };
    return lowerer.applyWidthLift(entry.lift, get, shape.type, loc);
  });
  lowerer.liftedFns.push({
    name,
    params: [{ localId: "r.0", name: "r", type: fromT }],
    returnType: toT,
    locals: [{ id: "r.0", name: "r", type: fromT, mutable: true }],
    body: [
      {
        kind: "return",
        value: constructedValue(lowerer, info, { kind: "new", className, args, type: toT, loc }),
        loc,
      },
    ],
    loc,
  });
  return name;
}

/** A CLASS VALUE's statics projected into a record shape (`var f:
 * ShapeFactory = Shape`): the record literal capturing static FIELDS as
 * copies of their globals and static METHODS as the zero-capture
 * closures `const f = C.m` builds (params all required — value-form
 * completion rules stay out of coercions). Inherited statics resolve
 * like JS's class-object prototype walk. Divergence 305's copy stance:
 * later writes to a writable static field don't flow into the record
 * (Node aliases the one class object). Null when any target field has
 * no projectable static. */
export function classStaticsProjection(
  lowerer: Lowerer,
  className: string,
  toId: string,
  loc: SrcLoc,
): IrExpr | null {
  const info = lowerer.classes.get(className);
  const to = lowerer.shapes.get(toId);
  if (!info || !to || to.indexValue || to.tuple) return null;
  if (to.fields.some((f) => f.name.startsWith("%"))) return null;
  if (info.generic || !info.decl) return null;
  const fields: { name: string; value: IrExpr }[] = [];
  for (const tf of to.fields) {
    if (findGenericStaticOn(lowerer, info, tf.name)) return null;
    const found = findStaticOn(lowerer, info, tf.name);
    if (!found) {
      if (tf.type.kind !== "union") return null;
      const u = lowerer.absentFieldValue(tf.type, loc);
      if (!u) return null;
      fields.push({ name: tf.name, value: u });
      continue;
    }
    if (found.field !== undefined) {
      const read: IrExpr = {
        kind: "varRef",
        localId: found.field.globalId,
        type: found.field.type,
        loc,
      };
      const lift = lowerer.widthLiftPlan(found.field.type, tf.type);
      if (!lift) return null;
      fields.push({ name: tf.name, value: lowerer.applyWidthLift(lift, read, tf.type, loc) });
      continue;
    }
    if (found.method.params.some((p) => p.mode !== "required")) return null;
    const funcType: IrType = {
      kind: "func",
      params: found.method.params.map((p) => p.type),
      ret: found.method.ret,
    };
    const lift = lowerer.widthLiftPlan(funcType, tf.type);
    if (!lift) return null;
    const fnName = `%${found.declarer.def.name}.static:${tf.name}`;
    lowerer.noteEdge(fnName);
    const closure: IrExpr = { kind: "closure", fnName, captures: [], type: funcType, loc };
    fields.push({ name: tf.name, value: lowerer.applyWidthLift(lift, closure, tf.type, loc) });
  }
  return { kind: "recordLit", fields, type: { kind: "record", shapeId: toId }, loc };
}

/** Build both record and class-field projections from the same validated
 * plan. Missing fields and nested conversions keep target declaration order. */
function buildRecordProjection(
  lowerer: Lowerer,
  name: string,
  source: IrType & { kind: "record" | "object" },
  target: IrRecordShape,
  plan: Map<string, FieldLift>,
  loc: SrcLoc,
  originOf: (field: string) => string | null = () => null,
): IrFunction {
  const parameter = source.kind === "record" ? "r" : "o";
  const localId = parameter + ".0";
  const receiver = varRef(localId, source, loc);
  const result: IrType = { kind: "record", shapeId: target.id };
  // A record source's copy keeps the source's key order; a class
  // instance's fields keep today's table.
  const copyOf = (node: IrExpr): IrExpr =>
    source.kind === "record" ? lowerer.keyOrder.copy(node, source.shapeId) : node;
  return {
    name,
    params: [{ localId, name: parameter, type: source }],
    returnType: result,
    locals: [{ id: localId, name: parameter, type: source, mutable: true }],
    body: [
      {
        kind: "return",
        value: copyOf({
          kind: "recordLit",
          fields: target.fields.map((field) => {
            const conversion = plan.get(field.name)!;
            if ("absentDyn" in conversion)
              return { name: field.name, value: dynUndefinedExpr(loc) };
            if ("absent" in conversion) {
              if (field.type.kind !== "union")
                throw new InternalCompilerError(
                  "lowerer bug: absent lift against a non-union field",
                );
              // The source has no such property: the projected field is
              // absent too.
              const value: IrExpr = {
                kind: "fieldAbsent",
                unionId: field.type.unionId,
                type: field.type,
                loc,
              };
              return { name: field.name, value };
            }
            const read: IrExpr =
              source.kind === "record"
                ? {
                    kind: "recordGet",
                    obj: receiver,
                    shapeId: source.shapeId,
                    field: field.name,
                    type: conversion.src,
                    loc,
                  }
                : {
                    kind: "fieldGet",
                    obj: receiver,
                    className: source.className,
                    field: field.name,
                    type: conversion.src,
                    loc,
                  };
            // Only the field's own extraction (a plain narrow) carries the
            // declared field's origin; nested conversions are shared.
            lowerer.coercionFieldOrigin =
              conversion.lift.how === "narrow" ? originOf(field.name) : null;
            const lifted = lowerer.applyWidthLift(conversion.lift, read, field.type, loc);
            lowerer.coercionFieldOrigin = null;
            return {
              name: field.name,
              value:
                source.kind === "record"
                  ? lowerer.presenceKeepingCopy(receiver, source.shapeId, field.name, lifted, loc)
                  : lifted,
            };
          }),
          type: result,
          loc,
        }),
        loc,
      },
    ],
    loc,
  };
}

/** Records and arrays (and unions holding them), whose identity a live
 * capsule keeps. */
function liveBoxable(lowerer: Lowerer, t: IrType, seen = new Set<string>()): boolean {
  if (t.kind === "record") {
    const shape = lowerer.shapes.get(t.shapeId);
    return shape !== undefined && !shape.tuple;
  }
  if (t.kind === "array") return true;
  if (t.kind !== "union" || seen.has(t.unionId)) return false;
  seen.add(t.unionId);
  return (
    lowerer.unions.get(t.unionId)?.arms.some((arm) => liveBoxable(lowerer, arm, seen)) ?? false
  );
}
