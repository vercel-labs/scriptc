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
 *   member and names the deepest failing path. */
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
    if (kept.length === 0 || kept.length === values.length) return null;
    if (asserted.kind === "union" && expected.kind === "union") {
      // The arms T excludes trap; the others (units included) re-tag.
      const trappable = new Set<number>();
      from.arms.forEach((arm, tag) => {
        if (!isUnitType(arm) && !kept.includes(arm)) trappable.add(tag);
      });
      const helper = unionRetagHelper(lowerer, from.id, expected.unionId, loc, trappable);
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
  if (expected.kind !== "record" && expected.kind !== "array") return null;
  if (expected.kind === "record" && lowerer.shapes.get(expected.shapeId)?.indexValue !== undefined)
    return null;
  if (
    !lowerer.dynConvertible(expr.type) ||
    !canDynCheckTo(
      expected,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  )
    return null;
  return { kind: "dynCheck", value: lowerer.coerceToExpected(expr, DYN), type: expected, loc };
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
