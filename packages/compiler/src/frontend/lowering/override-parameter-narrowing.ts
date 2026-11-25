/* Overrides that declare a narrower parameter than the method they override.
 *
 * TypeScript checks method parameters bivariantly, so an override may
 * declare a parameter narrower than its base declares it: one arm of the
 * inherited union (`m(v: string)` over `m(v: string | string[])`), the
 * value without `undefined` (`m(v: string)` over `m(v?: string)`), or a
 * subclass of the inherited class. The slot keeps the inherited ABI, so a
 * call through a base-typed receiver, an interface or an untyped value can
 * hand the override a value its parameter does not declare.
 *
 * The override's body lowers under its declared parameters (`%C.m$own`),
 * and the slot function converts each inherited argument with a CHECKED
 * conversion: a value the override declares passes through as it is; any
 * other value throws a TypeError naming the method and the parameter,
 * before the body runs. Node would run the body with the wider value; a
 * compiled body types the parameter as declared and has no reading of
 * that value, so the call is refused loudly instead (a failed checked
 * conversion throws; a type is never a lie).
 *
 * Calls through the override's own class enter `%C.m$own` directly (the
 * adapted-override rule in lowerObjectMethodCall), so the well-typed path
 * pays for no check. */
import type * as ts from "../ts7/adapter.js";
import { nodeThrowExpr } from "../../ir/build.js";
import { BOOL, isUnitType, typeEquals } from "../../ir/ir.js";
import type { IrExpr, IrType } from "../../ir/ir.js";
import type { Lowerer } from "./lowerer.js";

/** Whether a slot argument of type `inherited` reaches a parameter of the
 * narrower type `own` through one of the checked conversions
 * narrowOverrideArgument builds: `own` is an arm of the inherited union,
 * a union of some of its arms, or a strict subclass of the inherited
 * class. Tuples over arrays, records over wider records and subclasses of
 * a union's class arm have no in-place checked view and stay refused. */
export function overrideParameterNarrows(
  lowerer: Lowerer,
  inherited: IrType,
  own: IrType,
  /** The class being collected, which the class graph does not hold yet,
   * and its base: a parameter typed as the class itself narrows every
   * class above it. */
  collecting?: { className: string; base: { def: { name: string } } | null },
): boolean {
  if (typeEquals(inherited, own)) return false;
  if (inherited.kind === "object" && own.kind === "object") {
    if (lowerer.isSubclassOf(own.className, inherited.className)) return true;
    if (collecting === undefined || collecting.base === null) return false;
    const above = collecting.base.def.name;
    const fromCollecting = (name: string): boolean =>
      name === above || lowerer.isSubclassOf(above, name);
    // Only the class being collected can be missing from the graph: its
    // subclasses collect after it.
    return own.className === collecting.className && fromCollecting(inherited.className);
  }
  if (inherited.kind !== "union") return false;
  const from = lowerer.unions.get(inherited.unionId);
  if (!from) return false;
  if (own.kind !== "union") return !isUnitType(own) && lowerer.armTag(inherited.unionId, own) >= 0;
  const to = lowerer.unions.get(own.unionId);
  return (
    to !== undefined &&
    to.arms.length < from.arms.length &&
    to.arms.every((arm) => lowerer.armTag(inherited.unionId, arm) >= 0)
  );
}

/** The checked conversion of the slot argument `value` (a parameter
 * reference, safe to read twice) into the override's parameter type, or
 * null when the pair is not a narrowing (the slot's ordinary coercion
 * applies). `method` is `Class.method` and `parameter` the parameter's
 * name, for the TypeError. */
export function narrowOverrideArgument(
  lowerer: Lowerer,
  blame: ts.Node,
  value: IrExpr,
  own: IrType,
  method: string,
  parameter: string,
): IrExpr | null {
  const inherited = value.type;
  if (!overrideParameterNarrows(lowerer, inherited, own)) return null;
  const loc = value.loc;
  const refuse = (what: string): IrExpr =>
    nodeThrowExpr(
      1,
      "",
      `${method}: this override declares parameter '${parameter}' as '${lowerer.fmt(own)}', and a call that reached it through a wider type passed ${what}`,
      own,
      loc,
    );
  if (inherited.kind === "object" && own.kind === "object") {
    return {
      kind: "ternary",
      cond: { kind: "instanceOf", value, className: own.className, type: BOOL, loc },
      then: { kind: "downcast", value, type: own, loc },
      else_: refuse(`a '${lowerer.fmt(inherited)}' value that is not a '${lowerer.fmt(own)}'`),
      type: own,
      loc,
    };
  }
  if (inherited.kind !== "union") return null;
  const unionId = inherited.unionId;
  const from = lowerer.unions.get(unionId)!;
  const spelled = (arm: IrType): string =>
    isUnitType(arm)
      ? arm.kind === "undefinedT"
        ? "undefined"
        : "null"
      : `a '${lowerer.fmt(arm)}' value`;
  const isTag = (tag: number): IrExpr => ({
    kind: "unionIsTag",
    unionId,
    tag,
    negated: false,
    value,
    type: BOOL,
    loc,
  });
  // The arms the override declares, by their tag in the inherited union.
  const kept = new Set<number>();
  let accepted: IrExpr;
  if (own.kind === "union") {
    for (const arm of lowerer.unions.get(own.unionId)!.arms) kept.add(lowerer.armTag(unionId, arm));
    const stranded = new Set<number>();
    from.arms.forEach((_, tag) => {
      if (!kept.has(tag)) stranded.add(tag);
    });
    // The stranded arms never reach the re-tag: each is refused below.
    const helper = lowerer.unionRetagHelper(unionId, own.unionId, loc, stranded);
    if (helper === null)
      lowerer.unsupported(
        "SC1090",
        blame,
        `an override whose parameter '${parameter}' narrows '${lowerer.fmt(inherited)}' to '${lowerer.fmt(own)}' (the narrower union has no checked view of the inherited one)`,
      );
    accepted = { kind: "call", callee: helper, args: [value], type: own, loc };
  } else {
    const tag = lowerer.armTag(unionId, own);
    kept.add(tag);
    accepted = { kind: "unionNarrow", unionId, tag, value, type: own, loc };
  }
  let result: IrExpr = accepted;
  for (let tag = from.arms.length - 1; tag >= 0; tag--) {
    if (kept.has(tag)) continue;
    result = {
      kind: "ternary",
      cond: isTag(tag),
      then: refuse(spelled(from.arms[tag]!)),
      else_: result,
      type: own,
      loc,
    };
  }
  return result;
}
