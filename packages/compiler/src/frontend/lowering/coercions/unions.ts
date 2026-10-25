import { keyedHelperName } from "../stable-names.js";
import { buildUnionNarrow, unionNarrowFailureMessage } from "../union-narrow.js";
import { isSafeToRepeat } from "../expressions/evaluation-safety.js";
import { nodeThrowExpr } from "../../../ir/build.js";
import {
  planUnionRetag,
  buildUnionRetag,
  planRecordUnionLift,
  planRecordUnionWrap,
  buildRecordUnionWrap,
} from "../union-retag.js";
import { InternalCompilerError } from "../../../errors.js";
import * as ts from "../../ts7/adapter.js";
import type { IrExpr, IrType, SrcLoc } from "../../../ir/ir.js";
import { BOOL, F64, isUnitType, STRING, typeEquals } from "../../../ir/ir.js";
import { typeKey } from "../../type-mapper.js";
import type { Lowerer } from "../lowerer.js";

/** Validate the complete union conversion before interning helpers.
 * Recursive width plans close through the same in-progress pair guard;
 * no optimistic result is memoized after that planning stack unwinds. */
export function unionRetagMappable(lowerer: Lowerer, fromId: string, toId: string): boolean {
  const from = lowerer.unions.get(fromId);
  const to = lowerer.unions.get(toId);
  if (!from || !to) return false;
  const key = `u:${fromId}:${toId}`;
  if (lowerer.coercions.planning.has(key)) return true;
  lowerer.coercions.planning.add(key);
  try {
    return (
      planUnionRetag(
        from,
        to,
        (id) => lowerer.shapes.get(id),
        (src, dst) => lowerer.widthLiftPlan(src, dst),
      ) !== null
    );
  } finally {
    lowerer.coercions.planning.delete(key);
  }
}

/** A checker-NARROWED union flowing into a different union: `typeof r
 * === "string" || Buffer.isBuffer(r)` proves the record arm of r away,
 * then `{ data: r }` needs `Buffer | string | Rec` in a `Buffer | string`
 * slot. Control-flow narrowing to a sub-union erases at lowering, so the
 * IR value still carries the wide union — but the SITE's checker type
 * names exactly the arms still possible, and every one of those must
 * exist in both unions. The stranded arms compile to trap cases exactly
 * like stranded units (divergence 38's trust-the-checker stance): sound
 * narrowing never reaches them, a lying cast throws a catchable
 * TypeError instead of smuggling an unrepresentable arm. Null when the
 * site type isn't a genuine sub-union of the source (the SC2003 fence
 * stays). */
export function narrowedRetagHelper(
  lowerer: Lowerer,
  node: ts.Node,
  fromId: string,
  toId: string,
  loc: SrcLoc,
): string | null {
  const from = lowerer.unions.get(fromId);
  if (!from || !lowerer.unions.get(toId)) return null;
  const siteT = lowerer.mapTypeOf(lowerer.typeOf(node));
  if (!siteT) return null;
  const siteArms = siteT.kind === "union" ? lowerer.unions.get(siteT.unionId)?.arms : [siteT];
  if (!siteArms || siteArms.length === 0) return null;
  const allowed = new Set<number>();
  for (const a of siteArms) {
    const fi = lowerer.armTag(fromId, a);
    if (fi < 0) return null; // not a narrowing of the source union
    allowed.add(fi);
  }
  const trappable = new Set<number>();
  from.arms.forEach((_, i) => {
    if (!allowed.has(i)) trappable.add(i);
  });
  if (trappable.size === 0) return null; // nothing stranded: the plain re-tag already declined
  return lowerer.unionRetagHelper(fromId, toId, loc, trappable);
}

/** A union conversion whose source arms include an object type with a
 * required property of type `never` (the error arm of `Result<T, never>`).
 * No value has that type, but its arm still has a storage layout (never
 * maps to the f64 placeholder) that no destination arm matches. When the
 * node's checker type proves a source arm uninhabited, the re-tag traps on
 * it instead of needing a destination. Optional `never` properties,
 * `never[]` and functions returning `never` have values and keep their
 * arms. Null when no source arm is proven uninhabited. */
export function uninhabitedArmRetagHelper(
  lowerer: Lowerer,
  node: ts.Node,
  fromId: string,
  toId: string,
  loc: SrcLoc,
): string | null {
  const type = lowerer.typeOf(node);
  if (!type.isUnionType()) return null;
  const uninhabited = new Set<number>();
  const inhabited = new Set<number>();
  for (const part of ts.constituentTypes(type)) {
    const arm = lowerer.mapTypeOf(part);
    const tag = arm ? lowerer.armTag(fromId, arm) : -1;
    if (tag < 0) continue;
    (hasRequiredNeverProperty(lowerer, part) ? uninhabited : inhabited).add(tag);
  }
  // An arm shared with an inhabited constituent holds real values.
  for (const tag of inhabited) uninhabited.delete(tag);
  if (uninhabited.size === 0) return null;
  return lowerer.unionRetagHelper(fromId, toId, loc, uninhabited);
}

function hasRequiredNeverProperty(lowerer: Lowerer, type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  return lowerer.checker
    .getPropertiesOfType(type)
    .some(
      (property) =>
        (property.flags & ts.SymbolFlags.Optional) === 0 &&
        (lowerer.checker.getTypeOfSymbol(property).flags & ts.TypeFlags.Never) !== 0,
    );
}

/** The stranded-UNIT trap for PLAIN (non-union) slots: a null/undefined
 * value flowing into a non-nullable typed slot the checker approved —
 * `null!` and `null as any as T` casts, and the non-strict world's
 * legal `let s: string = null`. The compiled representation has no null
 * to carry, so the FLOW throws the catchable stranded TypeError
 * (divergence 38's stance: Node lets the impossible value ride until it
 * is used; the trap surfaces at the assignment instead). Unit sources
 * only — they are pure, so the nullary helper evaluates nothing. */
export function strandedUnitTrap(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (!isUnitType(expr.type)) return null;
  if (
    expected.kind === "union" ||
    expected.kind === "void" ||
    expected.kind === "dyn" ||
    isUnitType(expected)
  ) {
    return null;
  }
  const what = expr.type.kind === "undefinedT" ? "undefined" : "null";
  const key = `strandunit:${typeKey(expected)}:${expr.type.kind}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%unit.strand", key);
    lowerer.coercions.retags.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [],
      returnType: expected,
      locals: [],
      body: [
        {
          kind: "throw",
          value: {
            kind: "libCall",
            fn: "error.new",
            args: [
              {
                kind: "strLit",
                value: `${what} is not representable in a '${lowerer.fmt(expected)}' slot (a value narrowed or asserted past the type still held it)`,
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
      loc,
    });
  }
  return { kind: "call", callee: name, args: [], type: expected, loc };
}

/** The STRANDED-SOURCE trap: a checker-approved value flowing into a
 * union that cannot represent it (armTag < 0, no class widening, no
 * width lift). Only shapes that PROVE a lying assertion trap: unit
 * sources (null/undefined literals smuggled through `null!` / `as any`
 * casts), and record/array sources with ZERO same-family width-lift
 * candidates among the arms — an AMBIGUOUS lift (several candidates)
 * stays a compile fence, because honest code lands there. The interned
 * helper evaluates the operand (JS evaluates it too) and throws the
 * stranded-arm TypeError verbatim. Null when the shape doesn't prove
 * the lie. */
export function strandedCoercionTrap(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType & { kind: "union" },
  loc: SrcLoc,
): IrExpr | null {
  const def = lowerer.unions.get(expected.unionId);
  if (!def) return null;
  const src = expr.type;
  let what: string;
  if (isUnitType(src)) {
    what = src.kind === "undefinedT" ? "undefined" : "null";
  } else if (src.kind === "f64" || src.kind === "bool" || src.kind === "string") {
    // A SCALAR the union has no arm for (`4 as any as X`, a generic
    // dummy for an unmappable instantiation): no widening exists at
    // all, so the mismatch proves the lie the same way a unit does.
    what = `a '${lowerer.fmt(src)}' value`;
  } else if (src.kind === "record" || src.kind === "array") {
    // Zero width-lift candidates proves no honest mapping was missed.
    const candidates = def.arms.filter(
      (arm) =>
        ((src.kind === "record" && arm.kind === "record") ||
          (src.kind === "array" && arm.kind === "array")) &&
        lowerer.widthLiftPlan(src, arm) !== null,
    );
    if (candidates.length !== 0) return null;
    // An array also fits an object arm that only an array-like value
    // satisfies (`{ length: number; [i: number]: number }`): the flow is
    // honest, and the missing array-to-record conversion stays a fence.
    if (src.kind === "array" && def.arms.some((arm) => arrayLikeRecordArm(lowerer, arm)))
      return null;
    what = `a '${lowerer.fmt(src)}' value`;
  } else {
    return null;
  }
  // Unit sources have no runtime payload and are pure — the helper is
  // nullary (unit-typed ABI params have no representation); ref sources
  // pass through so the operand still evaluates, exactly JS.
  const takesOperand = !isUnitType(src);
  const key = `strand:${expected.unionId}:${typeKey(src)}`;
  let name = lowerer.coercions.retags.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%union.strand", key);
    lowerer.coercions.retags.set(key, name);
    const toT: IrType = { kind: "union", unionId: expected.unionId };
    lowerer.liftedFns.push({
      name,
      params: takesOperand ? [{ localId: "v.0", name: "v", type: src }] : [],
      returnType: toT,
      locals: takesOperand ? [{ id: "v.0", name: "v", type: src, mutable: false }] : [],
      body: [
        {
          kind: "throw",
          value: {
            kind: "libCall",
            fn: "error.new",
            args: [
              {
                kind: "strLit",
                value: `${what} is not representable in the target union (a value narrowed or asserted past it still held it)`,
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
      loc,
    });
  }
  return { kind: "call", callee: name, args: isUnitType(src) ? [] : [expr], type: expected, loc };
}

export function recordUnionWrapHelper(
  lowerer: Lowerer,
  source: IrType & { kind: "record" },
  toId: string,
  loc: SrcLoc,
): string | null {
  const shape = lowerer.shapes.get(source.shapeId);
  const to = lowerer.unions.get(toId);
  if (!shape || !to) return null;
  const plan = planRecordUnionWrap(shape, to, (id) => lowerer.shapes.get(id));
  if (!plan) return null;
  const key = `recordWrap:${source.shapeId}:${toId}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%record.wrap", key);
  lowerer.coercions.retags.set(key, name);
  lowerer.liftedFns.push(
    buildRecordUnionWrap(name, source, to, plan, loc, (lift, value, dst) =>
      lowerer.applyWidthLift(lift, value, dst, loc),
    ),
  );
  return name;
}

/** Interned `%record.route.<n>(r)`: a record that fits several arms of a
 * discriminated union, converted into the arm its discriminant names
 * (planRecordUnionLift). The width plan's `discriminantRoute` lift. */
export function recordUnionRouteHelper(
  lowerer: Lowerer,
  source: IrType & { kind: "record" },
  toId: string,
  loc: SrcLoc,
): string | null {
  const shape = lowerer.shapes.get(source.shapeId);
  const to = lowerer.unions.get(toId);
  if (!shape || !to) return null;
  const key = `recordRoute:${source.shapeId}:${toId}`;
  const existing = lowerer.coercions.retags.get(key);
  if (existing) return existing;
  const plan = planRecordUnionLift(
    shape,
    to,
    (id) => lowerer.shapes.get(id),
    (from, dst) => lowerer.widthLiftPlan(from, dst),
  );
  if (!plan) return null;
  const name = keyedHelperName(lowerer, "%record.route", key);
  lowerer.coercions.retags.set(key, name);
  lowerer.liftedFns.push(
    buildRecordUnionWrap(name, source, to, plan, loc, (lift, value, dst) =>
      lowerer.applyWidthLift(lift, value, dst, loc),
    ),
  );
  return name;
}

export function unionRetagHelper(
  lowerer: Lowerer,
  fromId: string,
  toId: string,
  loc: SrcLoc,
  trappable?: ReadonlySet<number>,
): string | null {
  const from = lowerer.unions.get(fromId);
  const to = lowerer.unions.get(toId);
  if (!from || !to) return null;
  const request = `${fromId}:${toId}:${trappable === undefined ? "" : [...trappable].sort((a, b) => a - b).join(".")}`;
  const cached = lowerer.coercions.copyRetags.get(request);
  if (
    cached &&
    cached.shapes === lowerer.shapes.revision &&
    cached.unions === lowerer.unions.revision
  )
    return cached.name;
  const plan = planUnionRetag(
    from,
    to,
    (id) => lowerer.shapes.get(id),
    (src, dst) => lowerer.widthLiftPlan(src, dst),
    trappable,
  );
  if (plan === null) return null;
  // The registry pair determines every route; only checker-proven
  // stranded arms vary by site. Publish the name before building widths
  // so recursive records and arrays can call this same helper.
  const stranded: number[] = [];
  plan.forEach((arm, tag) => {
    if (arm.kind === "trap") stranded.push(tag);
  });
  const key = `${fromId}:${toId}:${stranded.join(".")}`;
  const existing = lowerer.coercions.retags.get(key);
  const name = existing ?? keyedHelperName(lowerer, "%union.retag", key);
  if (!existing) {
    lowerer.coercions.retags.set(key, name);
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
  // Width routes still revalidate on every request. Only a complete plan
  // of exact payload copies and site-proven traps can bypass planning.
  if (
    plan.every(
      (arm) =>
        arm.kind === "trap" ||
        (arm.kind === "direct"
          ? arm.route.lift.how === "copy"
          : arm.routes.every((route) => route.lift.how === "copy")),
    )
  ) {
    lowerer.coercions.copyRetags.set(request, {
      name,
      shapes: lowerer.shapes.revision,
      unions: lowerer.unions.revision,
    });
  }
  return name;
}

/** Interned `%union.narrow.<n>(u)` — the CHECKED single-arm extraction
 * behind `x!` on union values: the asserted arm's payload comes out
 * (+1 for ref arms, like any unionNarrow), and every OTHER arm throws
 * the catchable TypeError — divergence 38's lying-assertion stance (an
 * unchecked unionNarrow would misread the payload where JS lets the
 * impossible value flow on). Null when the target isn't a non-unit arm
 * of the union — those uses keep their erasure/fences. */
export function narrowedArmHelper(
  lowerer: Lowerer,
  fromId: string,
  target: IrType,
  loc: SrcLoc,
): string | null {
  const from = lowerer.unions.get(fromId);
  if (!from || isUnitType(target)) return null;
  const tag = lowerer.armTag(fromId, target);
  if (tag < 0) return null;
  const key = `${fromId}:${tag}`;
  const existing = lowerer.coercions.narrows.get(key);
  if (existing) {
    lowerer.coercions.checkedNarrows.add(existing);
    return existing;
  }
  const name = keyedHelperName(lowerer, "%union.narrow", key);
  lowerer.coercions.narrows.set(key, name);
  lowerer.coercions.checkedNarrows.add(name);
  const fn = buildUnionNarrow(name, from, target, loc, (type) => lowerer.fmt(type));
  if (!fn) throw new InternalCompilerError("lowerer bug: invalid checked union extraction");
  lowerer.coercions.checkedNarrowArms.set(name, { unionId: fromId, tag, target: from.arms[tag]! });
  lowerer.liftedFns.push(fn);
  return name;
}

/** A checked extraction at its use. A plain read tests the stored tag in
 * place and projects the payload directly, so member reads can borrow it;
 * every other arm throws the helper's TypeError with the same message.
 * Other operands call the interned helper to evaluate them exactly once. */
export function checkedNarrowCall(
  lowerer: Lowerer,
  helper: string,
  value: IrExpr,
  type: IrType,
  loc: SrcLoc,
): IrExpr {
  const call: IrExpr = { kind: "call", callee: helper, args: [value], type, loc };
  const arm = lowerer.coercions.checkedNarrowArms.get(helper);
  const from = arm ? lowerer.unions.get(arm.unionId) : undefined;
  if (
    !arm ||
    !from ||
    from.arms.length < 2 ||
    value.type.kind !== "union" ||
    value.type.unionId !== arm.unionId ||
    !typeEquals(type, arm.target) ||
    !isSafeToRepeat(value)
  )
    return call;
  const unionId = arm.unionId;
  const isTag = (tag: number): IrExpr => ({
    kind: "unionIsTag",
    unionId,
    tag,
    negated: false,
    value,
    type: BOOL,
    loc,
  });
  let failure: IrExpr | null = null;
  for (let tag = from.arms.length - 1; tag >= 0; tag--) {
    if (tag === arm.tag) continue;
    const message = unionNarrowFailureMessage(from.arms[tag]!, (t) => lowerer.fmt(t));
    const thrown = nodeThrowExpr(1, "", message, type, loc);
    failure =
      failure === null
        ? thrown
        : { kind: "ternary", cond: isTag(tag), then: thrown, else_: failure, type, loc };
  }
  return {
    kind: "ternary",
    cond: isTag(arm.tag),
    then: { kind: "unionNarrow", unionId, tag: arm.tag, value, type, loc },
    else_: failure!,
    type,
    loc,
  };
}

/** A checked extraction found a value arm other than the one the checker
 * promised (a narrowing the program invalidated before the read). */
export const OTHER_ARM_FAILURE_MESSAGE =
  "a value of another type is not representable in the target union (a value narrowed or asserted past it still held it)";

/** checkedNarrowCall's in-place form with the TypeError of the consuming
 * operation: `messageFor` names Node's error for finding another arm
 * (`o.f is not a function`), or null for the stranded-value message. Null
 * when the operand cannot be evaluated more than once.
 *
 * The failure path stays small for wide unions: arms are grouped by their
 * message (every non-nullish arm without its own shares one), so it tests
 * at most the null and undefined arms before a final throw. */
export function checkedArmExtraction(
  lowerer: Lowerer,
  value: IrExpr,
  tag: number,
  arm: IrType,
  messageFor: (found: IrType) => string | null,
): IrExpr | null {
  if (value.type.kind !== "union" || !isSafeToRepeat(value)) return null;
  const unionId = value.type.unionId;
  const from = lowerer.unions.get(unionId);
  const stored = from?.arms[tag];
  if (!from || from.arms.length < 2 || !stored || !typeEquals(stored, arm)) return null;
  const loc = value.loc;
  const isTag = (t: number): IrExpr => ({
    kind: "unionIsTag",
    unionId,
    tag: t,
    negated: false,
    value,
    type: BOOL,
    loc,
  });
  const groups = new Map<string, number[]>();
  from.arms.forEach((found, t) => {
    if (t === tag) return;
    const message =
      messageFor(found) ??
      (isUnitType(found)
        ? unionNarrowFailureMessage(found, (type) => lowerer.fmt(type))
        : OTHER_ARM_FAILURE_MESSAGE);
    const tags = groups.get(message);
    if (tags) tags.push(t);
    else groups.set(message, [t]);
  });
  // The largest group needs no test of its own: it is whatever remains.
  const ordered = [...groups].sort((a, b) => a[1].length - b[1].length);
  const [lastMessage] = ordered.pop()!;
  let failure: IrExpr = nodeThrowExpr(1, "", lastMessage, arm, loc);
  for (const [message, tags] of ordered.reverse()) {
    let cond = isTag(tags[0]!);
    for (const t of tags.slice(1))
      cond = { kind: "logical", op: "||", left: cond, right: isTag(t), type: BOOL, loc };
    const thrown = nodeThrowExpr(1, "", message, arm, loc);
    failure = { kind: "ternary", cond, then: thrown, else_: failure, type: arm, loc };
  }
  return {
    kind: "ternary",
    cond: isTag(tag),
    then: { kind: "unionNarrow", unionId, tag, value, type: arm, loc },
    else_: failure,
    type: arm,
    loc,
  };
}

/** The operand of a checked extraction in either form checkedNarrowCall
 * produces, or null for every other expression. */
export function checkedNarrowOperand(lowerer: Lowerer, value: IrExpr): IrExpr | null {
  if (value.kind === "call")
    return lowerer.coercions.checkedNarrows.has(value.callee) && value.args.length === 1
      ? value.args[0]!
      : null;
  if (
    value.kind === "ternary" &&
    value.cond.kind === "unionIsTag" &&
    value.then.kind === "unionNarrow" &&
    value.then.value === value.cond.value &&
    value.then.tag === value.cond.tag &&
    !value.cond.negated
  )
    return value.cond.value;
  return null;
}

/** The DEFERRED-INIT field read (`stream!: T` assigned past the
 * constructor's top level — the slot is `T | undefined`): interned
 * `%deferred.read.<n>(u)` extracting the declared type. SCALAR arms
 * whose JS-undefined behavior a unit default reproduces read that
 * default — bool false (conditions are exact: undefined and false are
 * both falsy; only printing/strict-equality could tell) and f64 NaN
 * (arithmetic and conditions exact) — while string and REF arms keep
 * the checked-extraction TRAP: JS itself TypeErrors the first member
 * use of such an undefined, so the catchable TypeError at the read is
 * the same failure, named earlier (SEMANTICS.md). */
export function deferredReadHelper(
  lowerer: Lowerer,
  fromId: string,
  target: IrType,
  loc: SrcLoc,
): string | null {
  if (target.kind !== "bool" && target.kind !== "f64") {
    return lowerer.narrowedArmHelper(fromId, target, loc);
  }
  const from = lowerer.unions.get(fromId);
  const tag = lowerer.armTag(fromId, target);
  const utag = from ? from.arms.findIndex((a) => a.kind === "undefinedT") : -1;
  if (!from || tag < 0 || utag < 0) return null;
  const key = `deferred:${fromId}:${tag}`;
  const existing = lowerer.coercions.narrows.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%deferred.read", key);
  lowerer.coercions.narrows.set(key, name);
  const dflt: IrExpr =
    target.kind === "bool"
      ? { kind: "boolLit", value: false, type: BOOL, loc }
      : { kind: "numLit", value: NaN, type: F64, loc };
  const fn = buildUnionNarrow(name, from, target, loc, (type) => lowerer.fmt(type), dflt);
  if (!fn) throw new InternalCompilerError("lowerer bug: invalid deferred union extraction");
  lowerer.liftedFns.push(fn);
  return name;
}

/** A record arm an array value is assignable to: an index-signature record,
 * or one whose only declared field is `length`. */
function arrayLikeRecordArm(lowerer: Lowerer, arm: IrType): boolean {
  if (arm.kind !== "record") return false;
  const shape = lowerer.shapes.get(arm.shapeId);
  if (!shape || shape.tuple) return false;
  return (
    shape.indexValue !== undefined ||
    (shape.fields.length === 1 && shape.fields[0]!.name === "length")
  );
}
