/* Slots reached only through what a type assertion claims. */
import type { IrExpr, IrType, SrcLoc } from "../../../ir/ir.js";
import { canDynCheckTo, DYN, isUnitType, typeEquals } from "../../../ir/ir.js";
import { lowerRecordOvfCaptureHelper } from "../containers/indexed-objects.js";
import type { Lowerer } from "../lowerer.js";
import { unionRetagHelper } from "./unions.js";

/** A value an erased assertion produced (`x as T`, lowerer.assertedValues)
 * flowing into a slot that no ordinary conversion reaches. Runs only where
 * the slot would otherwise refuse the value (SC2002/SC2003), so every
 * conversion that already lowered keeps its code.
 *
 * - A union whose arms only partly convert (`api as Partial<Record<string,
 *   S>>` on `S | Partial<Record<K, S>> | undefined`): the arms that convert
 *   into T convert into the slot, and an arm the assertion excludes (no
 *   conversion into T) throws the catchable TypeError of a lying assertion.
 * - A record or array whose member types the assertion narrows (`models as
 *   Model<"one">[]` on a union-element array): the checked deep conversion
 *   a cast of an unknown value takes, which validates the value member by
 *   member and names the deepest failing path.
 * - A record or array beside unit arms asserted to a type it has no
 *   structural conversion into (`result as Sub` on `Base | undefined`, Sub
 *   declaring required members Base lacks): the unit arms throw the
 *   TypeError of a lying assertion, and the one value arm takes that same
 *   checked deep conversion.
 * - Several records or arrays with no unit beside them, none with a
 *   structural conversion into T (`load as Freight` on `Letter | Parcel`,
 *   in the instance of a generic function whose test sends only freight
 *   down that branch): the value takes the checked deep conversion as it
 *   stands. */
export function assertedConversion(
  lowerer: Lowerer,
  expr: IrExpr,
  expected: IrType,
): IrExpr | null {
  const asserted = lowerer.assertedValues.get(expr);
  if (!asserted) return null;
  const loc = expr.loc;
  if (expr.type.kind === "union") {
    const from = lowerer.unions.get(expr.type.unionId);
    if (!from) return null;
    const values = from.arms.filter((arm) => !isUnitType(arm));
    const kept = values.filter((arm) => convertsInto(lowerer, arm, asserted, loc));
    if (kept.length === 0) {
      // No arm reaches T by a structural conversion. One record or array
      // beside units is the value T names: extract it (a unit contradicts
      // the assertion) and check it into T member by member, then place
      // the result in the slot as a value of T.
      const arm = values.length === 1 ? values[0]! : null;
      // Several records or arrays and no unit, none of which is T's (a
      // generic function's instance asserting its parameter to the type
      // another instance holds, in the branch only that instance takes): the
      // value is checked into T as it stands, and whatever arm it holds
      // throws unless it has T's members. Beside a unit the union keeps its
      // refusal: the scan that refuses a write through the checked copy
      // (divergences.ts, widthCopyBetween) reads a union of records only.
      if (
        arm === null &&
        values.length > 1 &&
        values.length === from.arms.length &&
        values.every((value) => value.kind === "record" || value.kind === "array") &&
        checkedDeepConvertible(lowerer, expr.type, asserted)
      ) {
        const slot = lowerer.widthLiftPlan(asserted, expected);
        if (slot === null) return null;
        return lowerer.applyWidthLift(
          slot,
          checkedDeepConversion(lowerer, expr, asserted),
          expected,
          loc,
        );
      }
      if (arm === null || (arm.kind !== "record" && arm.kind !== "array")) return null;
      if (!checkedDeepConvertible(lowerer, arm, asserted)) return null;
      // Planned before any helper is interned, so a slot T does not reach
      // leaves the program as it was.
      const place = lowerer.widthLiftPlan(asserted, expected);
      if (place === null) return null;
      const helper = lowerer.narrowedArmHelper(from.id, arm, loc);
      if (!helper) return null;
      const claimed = checkedDeepConversion(
        lowerer,
        lowerer.checkedNarrowCall(helper, expr, arm, loc),
        asserted,
      );
      return lowerer.applyWidthLift(place, claimed, expected, loc);
    }
    if (kept.length === values.length) return null;
    if (asserted.kind === "union" && expected.kind === "union") {
      // The arms T excludes trap; the others (units included) re-tag.
      const trappable = new Set<number>();
      from.arms.forEach((arm, tag) => {
        if (!isUnitType(arm) && !kept.includes(arm)) trappable.add(tag);
      });
      // An excluded ARRAY arm the asserted type's tuple arm takes (`type as
      // Handler | [Handler]` over `Ctor | readonly Ctor[]`) converts through
      // the checked lane instead of trapping.
      const destination = lowerer.unions.get(expected.unionId);
      const checked =
        destination !== undefined &&
        [...trappable].some((tag) => {
          const arm = from.arms[tag]!;
          return (
            arm.kind === "array" &&
            destination.arms.filter((to) => lowerer.checkedWidthLift(arm, to) !== null).length === 1
          );
        });
      const helper = checked
        ? unionRetagHelper(lowerer, from.id, expected.unionId, loc, trappable, undefined, true)
        : unionRetagHelper(lowerer, from.id, expected.unionId, loc, trappable);
      return helper ? { kind: "call", callee: helper, args: [expr], type: expected, loc } : null;
    }
    // A record or array T holds one arm's values: extract that arm (every
    // other arm, a unit too, contradicts the assertion) and convert it.
    if (asserted.kind === "union" || kept.length !== 1) return null;
    const arm = kept[0]!;
    const helper = lowerer.narrowedArmHelper(from.id, arm, loc);
    if (!helper) return null;
    const narrowed = lowerer.checkedNarrowCall(helper, expr, arm, loc);
    if (typeEquals(arm, expected)) return narrowed;
    const converted = lowerer.coerceToExpected(narrowed, expected);
    return typeEquals(converted.type, expected) ? converted : null;
  }
  if (!checkedDeepConvertible(lowerer, expr.type, expected)) return null;
  return checkedDeepConversion(lowerer, expr, expected);
}

/** Whether a value of `source` can take the checked deep conversion into
 * `expected`: a record without an index signature or an array, reached
 * from a value the checked-dynamic representation holds. */
function checkedDeepConvertible(lowerer: Lowerer, source: IrType, expected: IrType): boolean {
  if (expected.kind !== "record" && expected.kind !== "array") return false;
  if (expected.kind === "record" && lowerer.shapes.get(expected.shapeId)?.indexValue !== undefined)
    return false;
  return (
    // A module namespace has no static conversion into a record, but its
    // dynamic value does: the box reads the namespace's members live.
    (lowerer.dynConvertible(source) || source.kind === "moduleNs") &&
    canDynCheckTo(
      expected,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  );
}

/** The checked deep conversion itself (checkedDeepConvertible held). */
function checkedDeepConversion(lowerer: Lowerer, expr: IrExpr, expected: IrType): IrExpr {
  return {
    kind: "dynCheck",
    value: lowerer.coerceToExpected(expr, DYN),
    type: expected,
    loc: expr.loc,
  };
}

/** True when a value of `arm` has a structural conversion into `target`:
 * the same type, one of its arms, a width lift, or (into an
 * index-signature record) the overflow capture. */
function convertsInto(lowerer: Lowerer, arm: IrType, target: IrType, loc: SrcLoc): boolean {
  if (typeEquals(arm, target)) return true;
  if (
    target.kind === "union" &&
    lowerer.unions.get(target.unionId)?.arms.some((candidate) => typeEquals(candidate, arm))
  )
    return true;
  if (lowerer.widthLiftPlan(arm, target) !== null) return true;
  return (
    arm.kind === "record" &&
    target.kind === "record" &&
    lowerer.shapes.get(target.shapeId)?.indexValue !== undefined &&
    lowerRecordOvfCaptureHelper(lowerer, arm.shapeId, target.shapeId, loc) !== null
  );
}
