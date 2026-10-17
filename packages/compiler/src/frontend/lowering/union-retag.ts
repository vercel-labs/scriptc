import { InternalCompilerError } from "../../errors.js";
import {
  BOOL,
  F64,
  STRING,
  isUnitType,
  shapeHasAccessorSlots,
  typeEquals,
  typeKey,
} from "../../ir/ir.js";
import type {
  IrExpr,
  IrFunction,
  IrRecordShape,
  IrStmt,
  IrType,
  IrUnionDef,
  SrcLoc,
} from "../../ir/ir.js";
import type { WidthLift } from "./width-lift.js";
import { discriminantField, discriminantOwners } from "../union-discriminants.js";

type Literal = string | number | boolean;

export interface UnionRetagRoute {
  tag: number;
  lift: WidthLift;
  values: Literal[];
}

export type UnionRetagArm =
  | { kind: "trap" }
  | { kind: "direct"; route: UnionRetagRoute }
  | { kind: "discriminant"; field: string; fieldType: IrType; routes: UnionRetagRoute[] };

export interface RecordUnionWrapPlan {
  field: string;
  fieldType: IrType;
  routes: UnionRetagRoute[];
}

/** Recursive variants can retain distinct ids for the same field layout.
 * An independently inferred record may intern to either id, so that id
 * alone cannot select its semantic destination when wrapping into a union. */
export function planRecordUnionWrap(
  source: IrRecordShape,
  to: IrUnionDef,
  shapeOf: (id: string) => IrRecordShape | undefined,
): RecordUnionWrapPlan | null {
  const discriminant = to.discriminant;
  if (!discriminant || source.tuple || source.indexValue || shapeHasAccessorSlots(source))
    return null;
  const fieldType = discriminantField(source, discriminant.field);
  if (!fieldType) return null;
  const routes: UnionRetagRoute[] = [];
  for (let tag = 0; tag < to.arms.length; tag++) {
    const arm = to.arms[tag]!;
    if (arm.kind !== "record") continue;
    const target = shapeOf(arm.shapeId);
    if (
      !target ||
      target.tuple ||
      target.indexValue ||
      target.fields.length !== source.fields.length
    )
      continue;
    let same = true;
    for (let i = 0; i < source.fields.length; i++) {
      const a = source.fields[i]!,
        b = target.fields[i]!;
      if (a.name !== b.name || !typeEquals(a.type, b.type)) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    const entry = discriminant.cases.find((candidate) => candidate.tag === tag);
    if (!entry) return null;
    routes.push({
      tag,
      lift: { how: arm.shapeId === source.id ? "copy" : "width" },
      values: entry.values,
    });
  }
  if (routes.length < 2 || discriminantOwners(to, shapeOf) === null) return null;
  return { field: discriminant.field, fieldType, routes };
}

/** Pure conversion planning. A source storage tag need not denote just
 * one semantic variant: refinements can coalesce recursive record layouts.
 * When both unions name the same discriminant, its values select target
 * tags, and every selected payload conversion must independently validate.
 * Planning never interns a helper or caches a recursive assumption. */
export function planUnionRetag(
  from: IrUnionDef,
  to: IrUnionDef,
  shapeOf: (id: string) => IrRecordShape | undefined,
  widthLift: (src: IrType, dst: IrType) => WidthLift | null,
  trappable?: ReadonlySet<number>,
): UnionRetagArm[] | null {
  const result: UnionRetagArm[] = [];
  const target: IrType = { kind: "union", unionId: to.id };
  const discriminant = from.discriminant;
  const useDiscriminant =
    discriminant !== undefined && discriminant.field === to.discriminant?.field;
  const owners = useDiscriminant ? discriminantOwners(to, shapeOf) : null;
  if (useDiscriminant && (owners === null || discriminantOwners(from, shapeOf) === null))
    return null;
  // Large unions otherwise compare every source arm with every destination.
  // Keys narrow the search; exact ABI equality still resolves collisions.
  // Keep small conversions allocation-light and rebuild for each registry view.
  const indexed = from.arms.length >= 4 && to.arms.length >= 8;
  const identities = new Map<string, number[]>();
  if (indexed)
    to.arms.forEach((arm, tag) => {
      const key = typeKey(arm);
      const tags = identities.get(key);
      if (tags) tags.push(tag);
      else identities.set(key, [tag]);
    });
  for (let tag = 0; tag < from.arms.length; tag++) {
    const source = from.arms[tag]!;
    const identity = indexed
      ? (identities
          .get(typeKey(source))
          ?.find((candidate) => typeEquals(to.arms[candidate]!, source)) ?? -1)
      : to.arms.findIndex((arm) => typeEquals(arm, source));
    if (isUnitType(source)) {
      result.push(
        identity < 0
          ? { kind: "trap" }
          : {
              kind: "direct",
              route: { tag: identity, lift: { how: "copy" }, values: [] },
            },
      );
      continue;
    }
    // A checker-proven absent arm retains any exact representation, as
    // before. Otherwise the narrowing path needs no structural conversion.
    if (identity < 0 && (trappable?.has(tag) || from.uninhabited?.includes(tag))) {
      result.push({ kind: "trap" });
      continue;
    }
    if (useDiscriminant && discriminant && owners && source.kind === "record") {
      const entry = discriminant.cases.find((candidate) => candidate.tag === tag);
      const fieldType = discriminantField(shapeOf(source.shapeId), discriminant.field);
      if (!entry || !fieldType) return null;
      const routes: UnionRetagRoute[] = [];
      for (const value of entry.values) {
        // Narrowing can remove semantic cases without changing a storage
        // arm. Retain that exact representation for omitted literals, while
        // explicit owners still select their own payload layouts.
        const destination =
          owners.get(JSON.stringify(value)) ?? (identity >= 0 ? identity : undefined);
        if (destination === undefined) return null;
        const existing = routes.find((route) => route.tag === destination);
        if (existing) {
          if (!existing.values.includes(value)) existing.values.push(value);
          continue;
        }
        const lift = widthLift(source, to.arms[destination]!);
        if (lift === null) return null;
        routes.push({ tag: destination, lift, values: [value] });
      }
      if (routes.length === 1) result.push({ kind: "direct", route: routes[0]! });
      else result.push({ kind: "discriminant", field: discriminant.field, fieldType, routes });
      continue;
    }
    if (identity >= 0) {
      result.push({ kind: "direct", route: { tag: identity, lift: { how: "copy" }, values: [] } });
      continue;
    }
    // Unannotated unions retain the unique-width-arm rule. A discriminant
    // present on just one side cannot establish correspondence.
    const lift = widthLift(source, target);
    if (!lift || lift.how !== "liftWrap") return null;
    const inner = widthLift(source, lift.arm);
    if (!inner) return null;
    result.push({ kind: "direct", route: { tag: lift.tag, lift: inner, values: [] } });
  }
  return result;
}

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

function literalTest(field: IrExpr, literal: Literal, loc: SrcLoc): IrExpr {
  if (typeof literal === "string") {
    return {
      kind: "strEq",
      negated: false,
      left: field,
      right: { kind: "strLit", value: literal, type: STRING, loc },
      type: BOOL,
      loc,
    };
  }
  const right: IrExpr =
    typeof literal === "number"
      ? { kind: "numLit", value: literal, type: F64, loc }
      : { kind: "boolLit", value: literal, type: BOOL, loc };
  return { kind: "bin", op: "===", left: field, right, type: BOOL, loc };
}

export function buildRecordUnionWrap(
  name: string,
  source: IrType & { kind: "record" },
  to: IrUnionDef,
  plan: RecordUnionWrapPlan,
  loc: SrcLoc,
  applyLift: (lift: WidthLift, value: IrExpr, dst: IrType) => IrExpr,
): IrFunction {
  const input: IrExpr = { kind: "varRef", localId: "v.0", type: source, loc };
  const field: IrExpr = { kind: "varRef", localId: "kind.0", type: plan.fieldType, loc };
  const result: IrType = { kind: "union", unionId: to.id };
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "kind.0",
      init: {
        kind: "recordGet",
        obj: input,
        shapeId: source.shapeId,
        field: plan.field,
        type: plan.fieldType,
        loc,
      },
      loc,
    },
  ];
  for (const route of plan.routes) {
    let cond: IrExpr | null = null;
    for (const literal of route.values) {
      const test = literalTest(field, literal, loc);
      cond =
        cond === null
          ? test
          : { kind: "logical", op: "||", left: cond, right: test, type: BOOL, loc };
    }
    if (cond === null)
      throw new InternalCompilerError("lowerer bug: empty record discriminator route");
    body.push({
      kind: "if",
      cond,
      then: [
        {
          kind: "return",
          value: {
            kind: "unionWrap",
            unionId: to.id,
            tag: route.tag,
            value: applyLift(route.lift, input, to.arms[route.tag]!),
            type: result,
            loc,
          },
          loc,
        },
      ],
      else_: null,
      loc,
    });
  }
  body.push(typeError(`invalid '${plan.field}' discriminant in record conversion`, loc));
  return {
    name,
    params: [{ localId: "v.0", name: "value", type: source }],
    returnType: result,
    locals: [
      { id: "v.0", name: "value", type: source, mutable: false },
      { id: "kind.0", name: "kind", type: plan.fieldType, mutable: false },
    ],
    body,
    loc,
  };
}

/** The source tags whose plan copies the payload into the same tag of an
 * equal target arm. Such a value has the same tag, payload and arm entry
 * points in both unions, so the conversion can keep the input itself. */
export function identityRetagTags(
  from: IrUnionDef,
  to: IrUnionDef,
  plan: readonly UnionRetagArm[],
): number[] {
  const tags: number[] = [];
  plan.forEach((armPlan, tag) => {
    const arm = from.arms[tag];
    const target = to.arms[tag];
    if (
      armPlan.kind === "direct" &&
      armPlan.route.tag === tag &&
      armPlan.route.lift.how === "copy" &&
      arm !== undefined &&
      target !== undefined &&
      typeEquals(arm, target)
    )
      tags.push(tag);
  });
  return tags;
}

/** Emit the already validated routes using ordinary typed IR. Each field
 * read uses the source shape; each result uses its own destination shape.
 * Arms with the same tag and type keep the input (unionRetype); other
 * exact routes retain the original payload and width routes copy it.
 * The caller interns the helper before invoking this build phase. */
export function buildUnionRetag(
  name: string,
  from: IrUnionDef,
  to: IrUnionDef,
  plan: UnionRetagArm[],
  loc: SrcLoc,
  applyLift: (lift: WidthLift, value: IrExpr, dst: IrType) => IrExpr,
  formatType: (type: IrType) => string,
): IrFunction {
  if (plan.length !== from.arms.length)
    throw new InternalCompilerError("lowerer bug: incomplete union retag plan");
  const fromType: IrType = { kind: "union", unionId: from.id };
  const toType: IrType = { kind: "union", unionId: to.id };
  const input: IrExpr = { kind: "varRef", localId: "u.0", type: fromType, loc };
  const fn: IrFunction = {
    name,
    params: [{ localId: "u.0", name: "u", type: fromType }],
    returnType: toType,
    locals: [{ id: "u.0", name: "u", type: fromType, mutable: false }],
    body: [],
    loc,
  };
  // Arms that keep their tag and exact type need no new box: the result
  // is the input viewed as the target union. Test them together first.
  const identities = identityRetagTags(from, to, plan);
  const retype: IrExpr = {
    kind: "unionRetype",
    fromId: from.id,
    unionId: to.id,
    tags: identities,
    value: input,
    type: toType,
    loc,
  };
  if (identities.length === from.arms.length) {
    fn.body.push({ kind: "return", value: retype, loc });
    return fn;
  }
  if (identities.length > 0) {
    let cond: IrExpr | null = null;
    for (const tag of identities) {
      const test: IrExpr = {
        kind: "unionIsTag",
        unionId: from.id,
        tag,
        negated: false,
        value: input,
        type: BOOL,
        loc,
      };
      cond =
        cond === null
          ? test
          : { kind: "logical", op: "||", left: cond, right: test, type: BOOL, loc };
    }
    fn.body.push({
      kind: "if",
      cond: cond!,
      then: [{ kind: "return", value: retype, loc }],
      else_: null,
      loc,
    });
  }
  const shared = new Set(identities);
  for (let tag = 0; tag < from.arms.length; tag++) {
    if (shared.has(tag)) continue;
    const arm = from.arms[tag]!;
    const armPlan = plan[tag]!;
    const statements: IrStmt[] = [];
    if (armPlan.kind === "trap") {
      const what = isUnitType(arm)
        ? arm.kind === "undefinedT"
          ? "undefined"
          : "null"
        : `a '${formatType(arm)}' value`;
      statements.push(
        typeError(
          `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
          loc,
        ),
      );
    } else {
      const payload: IrExpr = isUnitType(arm)
        ? {
            kind: "unitLit",
            unit: arm.kind === "undefinedT" ? "undefined" : "null",
            type: arm,
            loc,
          }
        : { kind: "unionNarrow", unionId: from.id, tag, value: input, type: arm, loc };
      if (armPlan.kind === "direct") {
        const route = armPlan.route;
        statements.push({
          kind: "return",
          value: {
            kind: "unionWrap",
            unionId: to.id,
            tag: route.tag,
            value: applyLift(route.lift, payload, to.arms[route.tag]!),
            type: toType,
            loc,
          },
          loc,
        });
      } else {
        if (arm.kind !== "record")
          throw new InternalCompilerError("lowerer bug: discriminant on non-record arm");
        // Capture once after testing the source tag. Reusing a field read
        // would repeatedly retain the payload and would obscure ownership.
        const localId = `kind.${tag}`;
        fn.locals.push({ id: localId, name: "kind", type: armPlan.fieldType, mutable: false });
        statements.push({
          kind: "varDecl",
          localId,
          init: {
            kind: "recordGet",
            obj: payload,
            shapeId: arm.shapeId,
            field: armPlan.field,
            type: armPlan.fieldType,
            loc,
          },
          loc,
        });
        const field: IrExpr = { kind: "varRef", localId, type: armPlan.fieldType, loc };
        for (const route of armPlan.routes) {
          let cond: IrExpr | null = null;
          for (const literal of route.values) {
            const test = literalTest(field, literal, loc);
            cond =
              cond === null
                ? test
                : { kind: "logical", op: "||", left: cond, right: test, type: BOOL, loc };
          }
          if (cond === null)
            throw new InternalCompilerError("lowerer bug: empty discriminant route");
          statements.push({
            kind: "if",
            cond,
            then: [
              {
                kind: "return",
                value: {
                  kind: "unionWrap",
                  unionId: to.id,
                  tag: route.tag,
                  value: applyLift(route.lift, payload, to.arms[route.tag]!),
                  type: toType,
                  loc,
                },
                loc,
              },
            ],
            else_: null,
            loc,
          });
        }
        statements.push(
          typeError(`invalid '${armPlan.field}' discriminant in union conversion`, loc),
        );
      }
    }
    fn.body.push({
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId: from.id,
        tag,
        negated: false,
        value: input,
        type: BOOL,
        loc,
      },
      then: statements,
      else_: null,
      loc,
    });
  }
  fn.body.push({
    kind: "throw",
    value: {
      kind: "strLit",
      value: "scriptc: internal error: invalid union tag",
      type: STRING,
      loc,
    },
    loc,
  });
  return fn;
}
