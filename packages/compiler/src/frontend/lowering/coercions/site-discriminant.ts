/* A value entering a union whose discriminant only tells some arms apart.
 *
 * A union keeps a discriminant in its definition only when one property
 * holds a literal in every record arm and no literal has two owners
 * (unionDiscriminant). A union with a catch-all arm (`command: string`
 * beside the arms that name one command) or with two arms that share a
 * literal has none, so a value that fits several of its arms by width has
 * no arm to enter and the conversion is refused (SC2003).
 *
 * The value still enters the union by its discriminant value, as in
 * JavaScript: the question is only which arms it can be. The checker types
 * of the conversion answer that. The arms the source type can be are those
 * no literal-valued property rules out (a source with `success: true`
 * cannot be the arm with `success: false`), and among them a property
 * whose every value the source can hold has exactly one owner selects the
 * arm at run time. Each selected arm takes the value by an ordinary width
 * lift, and a value no route names throws the catchable TypeError.
 *
 * The routes belong to one conversion: they are planned from its site's
 * checker types, the union definition is unchanged, and the conversion is
 * asked for only where it would otherwise be refused. */
import { InternalCompilerError } from "../../../errors.js";
import type { IrExpr, IrType, IrUnionDef } from "../../../ir/ir.js";
import { NULL_T, UNDEFINED_T, shapeHasAccessorSlots, typeEquals } from "../../../ir/ir.js";
import { literalValues } from "../../literal-values.js";
import * as ts from "../../ts7/adapter.js";
import { discriminantField, matchesLiteral, type UnionLiteral } from "../../union-discriminants.js";
import type { Lowerer } from "../lowerer.js";
import { keyedHelperName } from "../stable-names.js";
import {
  buildRecordUnionWrap,
  buildUnionRetag,
  planUnionRetag,
  type UnionRetagRoute,
  type UnionSiteRoute,
} from "../union-retag.js";

/** A record constituent of the destination's checker type and the arm of
 * the destination union that stores it. */
interface TargetArm {
  part: ts.Type;
  tag: number;
}

const UNIT = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null;

/** The conversion of `expr` (the lowered `node`) into the union `expected`
 * by the routes of this site, or null when the site has none: the
 * destination keeps a discriminant of its own, a checker type does not map
 * to the IR types in hand, or no property selects one arm per value. */
export function siteDiscriminantConversion(
  lowerer: Lowerer,
  node: ts.Node,
  expr: IrExpr,
  expected: IrType,
): IrExpr | null {
  if (expected.kind !== "union") return null;
  if (expr.type.kind !== "record" && expr.type.kind !== "union") return null;
  const to = lowerer.unions.get(expected.unionId);
  if (!to || to.discriminant !== undefined) return null;
  const targets = targetArms(lowerer, node, expected);
  if (targets === null) return null;
  // The value's own checker type: an erased assertion or parenthesis names
  // the same value as its operand, so the first of them whose type maps to
  // the lowered value's is the one to read.
  for (let source: ts.Node | undefined = node; source !== undefined; source = operandOf(source)) {
    const type = lowerer.typeOf(source);
    const parts = type.isUnionType() ? ts.constituentTypes(type) : [type];
    const converted =
      expr.type.kind === "record"
        ? recordConversion(lowerer, expr, expr.type, parts, targets, to)
        : unionConversion(lowerer, expr, expr.type, parts, targets, to);
    if (converted !== undefined) return converted;
  }
  return null;
}

/** The operand an erased wrapper (parentheses, an assertion, `satisfies`,
 * `!`) names, or undefined for every other node. */
function operandOf(node: ts.Node): ts.Node | undefined {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertion(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
    ? node.expression
    : undefined;
}

/** The record constituents of the destination's checker type, each with
 * its arm of `expected`. The type is the assertion's own (`x as U`) or the
 * slot's contextual type, taken only when it maps to `expected`. */
function targetArms(
  lowerer: Lowerer,
  node: ts.Node,
  expected: IrType & { kind: "union" },
): TargetArm[] | null {
  let site = node;
  while (ts.isParenthesizedExpression(site)) site = site.expression;
  const candidates: (ts.Type | undefined)[] = [
    ts.isAsExpression(site) || ts.isTypeAssertion(site)
      ? lowerer.checker.getTypeFromTypeNode(site.type)
      : undefined,
    lowerer.checker.getContextualType(node),
  ];
  for (const type of candidates) {
    if (!type || !type.isUnionType()) continue;
    const mapped = lowerer.mapTypeOf(type);
    if (!mapped || !typeEquals(mapped, expected)) continue;
    const arms: TargetArm[] = [];
    let complete = true;
    for (const part of ts.constituentTypes(type)) {
      if (part.flags & UNIT) continue;
      const arm = lowerer.mapTypeOf(part);
      if (!arm) {
        complete = false;
        break;
      }
      if (arm.kind !== "record") continue;
      const tag = lowerer.armTag(expected.unionId, arm);
      if (tag < 0) {
        complete = false;
        break;
      }
      arms.push({ part, tag });
    }
    if (complete && arms.length > 0) return arms;
  }
  return null;
}

/** A record source: undefined when `parts` is not the record's checker
 * type, null when it is and no route exists. */
function recordConversion(
  lowerer: Lowerer,
  expr: IrExpr,
  source: IrType & { kind: "record" },
  parts: readonly ts.Type[],
  targets: readonly TargetArm[],
  to: IrUnionDef,
): IrExpr | null | undefined {
  const own = parts.filter((part) => (part.flags & UNIT) === 0);
  if (own.length === 0) return undefined;
  for (const part of own) {
    const mapped = lowerer.mapTypeOf(part);
    if (!mapped || !typeEquals(mapped, source)) return undefined;
  }
  const plan = planSiteRoute(lowerer, own, source, targets, to);
  if (plan === null) return null;
  const key = `recordSite:${source.shapeId}:${to.id}:${routeKey(plan)}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%record.route", key);
    lowerer.coercions.retags.set(key, name);
    const loc = expr.loc;
    lowerer.liftedFns.push(
      buildRecordUnionWrap(name, source, to, plan, loc, (lift, value, dst) =>
        lowerer.applyWidthLift(lift, value, dst, loc),
      ),
    );
  }
  return {
    kind: "call",
    callee: name,
    args: [expr],
    type: { kind: "union", unionId: to.id },
    loc: expr.loc,
  };
}

/** A union source: undefined when `parts` is not a narrowing of the
 * union's checker type, null when it is and no route exists. The arms the
 * site's type excludes trap (as in narrowedRetagHelper), every arm the
 * ordinary re-tag places keeps its route, and an arm it cannot place takes
 * this site's routes. */
function unionConversion(
  lowerer: Lowerer,
  expr: IrExpr,
  source: IrType & { kind: "union" },
  parts: readonly ts.Type[],
  targets: readonly TargetArm[],
  to: IrUnionDef,
): IrExpr | null | undefined {
  const from = lowerer.unions.get(source.unionId);
  if (!from) return undefined;
  const allowed = new Set<number>();
  const byTag = new Map<number, ts.Type[]>();
  for (const part of parts) {
    const mapped =
      part.flags & ts.TypeFlags.Null
        ? NULL_T
        : part.flags & UNIT
          ? UNDEFINED_T
          : lowerer.mapTypeOf(part);
    if (!mapped) return undefined;
    const arms = mapped.kind === "union" ? lowerer.unions.get(mapped.unionId)?.arms : [mapped];
    if (!arms) return undefined;
    for (const arm of arms) {
      const tag = lowerer.armTag(from.id, arm);
      if (tag < 0) return undefined;
      allowed.add(tag);
      if (arm.kind === "record" && mapped.kind === "record") {
        const held = byTag.get(tag);
        if (held) held.push(part);
        else byTag.set(tag, [part]);
      }
    }
  }
  const routes = new Map<number, UnionSiteRoute>();
  for (const [tag, own] of byTag) {
    const arm = from.arms[tag]!;
    if (arm.kind !== "record") continue;
    const plan = planSiteRoute(lowerer, own, arm, targets, to);
    if (plan !== null) routes.set(tag, plan);
  }
  if (routes.size === 0) return null;
  const trappable = new Set<number>();
  from.arms.forEach((_, tag) => {
    if (!allowed.has(tag)) trappable.add(tag);
  });
  const plan = planUnionRetag(
    from,
    to,
    (id) => lowerer.shapes.get(id),
    (src, dst) => lowerer.widthLiftPlan(src, dst),
    trappable,
    undefined,
    undefined,
    routes,
  );
  if (plan === null) return null;
  const used: string[] = [];
  const stranded: number[] = [];
  plan.forEach((arm, tag) => {
    if (arm.kind === "trap") stranded.push(tag);
    // The destination has no discriminant of its own, so a discriminant
    // arm in the plan is this site's route.
    if (arm.kind === "discriminant" && routes.has(tag)) used.push(`${tag}>${routeKey(arm)}`);
  });
  if (used.length === 0) return null;
  const key = `unionSite:${from.id}:${to.id}:${stranded.join(".")}:${used.join("|")}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%union.retag", key);
    lowerer.coercions.retags.set(key, name);
    const loc = expr.loc;
    lowerer.liftedFns.push(
      buildUnionRetag(
        name,
        from,
        to,
        plan,
        loc,
        (lift, value, dst) => lowerer.applyWidthLift(lift, value, dst, loc),
        (type) => lowerer.fmt(type),
      ),
    );
  }
  return {
    kind: "call",
    callee: name,
    args: [expr],
    type: { kind: "union", unionId: to.id },
    loc: expr.loc,
  };
}

/** The routes of one source record layout, whose values have the checker
 * types `parts`, into the arms of `to`: the first property that is a
 * required literal in every part and in every arm a part can be, where
 * each value a part can hold has one owner arm and that arm takes the
 * record by a width lift. Null when no property selects that way, or when
 * the selected arm does not take the record. */
function planSiteRoute(
  lowerer: Lowerer,
  parts: readonly ts.Type[],
  source: IrType & { kind: "record" },
  targets: readonly TargetArm[],
  to: IrUnionDef,
): UnionSiteRoute | null {
  const shape = lowerer.shapes.get(source.shapeId);
  if (!shape || shape.tuple || shape.indexValue !== undefined || shapeHasAccessorSlots(shape))
    return null;
  const candidates = parts.map((part) =>
    targets.filter((target) => !excludes(lowerer, part, target.part)),
  );
  if (candidates.some((arms) => arms.length === 0)) return null;
  for (const property of lowerer.checker.getPropertiesOfType(parts[0]!)) {
    const field = ts.symbolName(property);
    const fieldType = discriminantField(shape, field);
    if (!fieldType) continue;
    const owners = ownersByValue(lowerer, field, fieldType, parts, candidates);
    if (owners === null) continue;
    const routes: UnionRetagRoute[] = [];
    for (const { value, tag } of owners) {
      const existing = routes.find((route) => route.tag === tag);
      if (existing) {
        existing.values.push(value);
        continue;
      }
      const lift = lowerer.widthLiftPlan(source, to.arms[tag]!);
      // The arm this value names does not hold the record: no other
      // property may send it elsewhere.
      if (lift === null) return null;
      routes.push({ tag, lift, values: [value] });
    }
    return { kind: "discriminant", field, fieldType, routes };
  }
  return null;
}

/** The owner arm of each value the parts can hold in `field`, or null when
 * the field does not select: a part or one of its candidate arms lacks it
 * as a required literal, a value has no owner or several, or two parts
 * disagree on a value's owner. */
function ownersByValue(
  lowerer: Lowerer,
  field: string,
  fieldType: IrType,
  parts: readonly ts.Type[],
  candidates: readonly (readonly TargetArm[])[],
): { value: UnionLiteral; tag: number }[] | null {
  const owners = new Map<string, { value: UnionLiteral; tag: number }>();
  for (let i = 0; i < parts.length; i++) {
    const values = requiredLiterals(lowerer, parts[i]!, field);
    if (!values) return null;
    const held: { tag: number; values: readonly UnionLiteral[] }[] = [];
    for (const candidate of candidates[i]!) {
      const own = requiredLiterals(lowerer, candidate.part, field);
      if (!own) return null;
      held.push({ tag: candidate.tag, values: own });
    }
    for (const value of values) {
      if (!matchesLiteral(fieldType, value)) return null;
      const tags = new Set<number>();
      for (const arm of held) if (arm.values.includes(value)) tags.add(arm.tag);
      if (tags.size !== 1) return null;
      const tag = [...tags][0]!;
      const key = JSON.stringify(value);
      const previous = owners.get(key);
      if (previous !== undefined && previous.tag !== tag) return null;
      owners.set(key, { value, tag });
    }
  }
  return owners.size > 0 ? [...owners.values()] : null;
}

/** True when a value of the checker type `source` cannot be a value of
 * `target`: both declare a required property as finite literals, and they
 * share none. */
function excludes(lowerer: Lowerer, source: ts.Type, target: ts.Type): boolean {
  for (const property of lowerer.checker.getPropertiesOfType(source)) {
    const name = ts.symbolName(property);
    const held = requiredLiterals(lowerer, source, name);
    if (!held) continue;
    const wanted = requiredLiterals(lowerer, target, name);
    if (wanted && !held.some((value) => wanted.includes(value))) return true;
  }
  return false;
}

/** The finite literal values of the required data property `name` of
 * `type`, or null when it has no such property. A property typed by a type
 * parameter holds the values of the parameter's declared constraint: an
 * instance body is shared by every argument the constraint admits. */
function requiredLiterals(lowerer: Lowerer, type: ts.Type, name: string): UnionLiteral[] | null {
  const property = lowerer.checker.getPropertyOfType(type, name);
  if (
    !property ||
    property.flags &
      (ts.SymbolFlags.Optional | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)
  )
    return null;
  let held = lowerer.checker.getTypeOfSymbol(property);
  if (held.flags & ts.TypeFlags.TypeParameter) {
    const constraint = held
      .getSymbol()
      ?.declarations.find((d): d is ts.TypeParameterDeclaration =>
        ts.isTypeParameterDeclaration(d),
      )?.constraint;
    if (!constraint) return null;
    held = lowerer.checker.getTypeFromTypeNode(constraint);
  }
  return literalValues(held);
}

/** The identity of a planned route for helper interning. */
function routeKey(plan: UnionSiteRoute): string {
  if (plan.routes.length === 0)
    throw new InternalCompilerError("lowerer bug: empty site discriminant route");
  return `${plan.field}=${plan.routes
    .map((route) => `${route.tag}:${route.values.map((value) => JSON.stringify(value)).join(",")}`)
    .join(";")}`;
}
