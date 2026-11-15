/* Direct conversions between two nullable-pointer single unions
 * (nullable-unions.ts). Both hold the reference arm's plain pointer, so a
 * conversion only has to translate the unit encodings that differ: NULL is
 * `undefined` in a `C | null | undefined` union and `null` in a `C | null`
 * one, where NULLABLE_NULL is `null`. Every other pointer (the reference
 * arm, or a unit arm both unions encode alike) passes through unchanged, so
 * the result shares the operand's reference: no box, retain or release. */
import { isUnitType, typeEquals, type IrType } from "../../ir/ir.js";
import type { BlockBuilder } from "./blocks.js";
import { NULLABLE_NULL, type NullableUnion, type PointerUnion } from "./nullable-unions.js";

/** How a nullable union's value spells one unit arm: NULL itself or the
 * immortal NULLABLE_NULL sentinel. */
type UnitEncoding = "null" | "sentinel";

/** One `select`: a value holding `from` holds `to` in the target union. */
export interface PointerRetypeStep {
  from: UnitEncoding;
  to: UnitEncoding;
}

/** The encoding `tag` has in `union`, or null when the tag is neither of
 * its unit arms (the tag of a payload arm, or an impossible one). */
function encodingOf(union: NullableUnion, tag: number): UnitEncoding | null {
  if (tag === union.unitTag) return "null";
  if (union.nullTag >= 0 && tag === union.nullTag) return "sentinel";
  return null;
}

/** The selects of a direct conversion of the source arms `tags` (IR
 * unionRetype's identity tags: each listed source tag keeps its index and
 * type in the target), or null when an arm needs a rebuild. */
export function pointerRetypeSteps(
  from: PointerUnion,
  to: PointerUnion,
  fromArms: readonly IrType[],
  toArms: readonly IrType[],
  tags: readonly number[],
): PointerRetypeStep[] | null {
  if (from.repr !== "single" || to.repr !== "single") return null;
  if (!typeEquals(from.arm, to.arm)) return null;
  const steps: PointerRetypeStep[] = [];
  for (const tag of tags) {
    const arm = fromArms[tag],
      target = toArms[tag];
    if (!arm || !target || !typeEquals(arm, target)) return null;
    if (!isUnitType(arm)) continue;
    const source = encodingOf(from, tag),
      destination = encodingOf(to, tag);
    if (source === null || destination === null) return null;
    if (source !== destination) steps.push({ from: source, to: destination });
  }
  return steps;
}

/** Emit the conversion of `value` (a pointer of the source encoding) and
 * answer the target-typed pointer. Ownership is unchanged: the result is
 * the operand's reference, or an immortal unit encoding. */
export function emitPointerRetype(
  B: BlockBuilder,
  value: string,
  steps: readonly PointerRetypeStep[],
): string {
  let current = value;
  for (const step of steps) {
    const matches = B.tmp(),
      next = B.tmp();
    B.line(`${matches} = icmp eq ptr ${current}, ${step.from === "null" ? "null" : NULLABLE_NULL}`);
    B.line(
      `${next} = select i1 ${matches}, ptr ${
        step.to === "null" ? "null" : NULLABLE_NULL
      }, ptr ${current}`,
    );
    current = next;
  }
  return current;
}
