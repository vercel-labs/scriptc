import { expect, test } from "vitest";
import { NULL_T, UNDEFINED_T, type IrType } from "../../ir/ir.js";
import { emitPointerRetype, pointerRetypeSteps, type PointerRetypeStep } from "./pointer-retype.js";
import { BlockBuilder } from "./blocks.js";

const cell: IrType = { kind: "record", shapeId: "cell" };
const other: IrType = { kind: "record", shapeId: "other" };
/** `cell | null`: NULL is `null`. */
const narrow = {
  repr: "single" as const,
  unionId: "narrow",
  refTag: 1,
  unitTag: 0,
  nullTag: -1,
  arm: cell,
};
/** `cell | null | undefined`: NULL is `undefined`, NULLABLE_NULL is `null`. */
const wide = {
  repr: "single" as const,
  unionId: "wide",
  refTag: 1,
  unitTag: 2,
  nullTag: 0,
  arm: cell,
};
const narrowArms: IrType[] = [NULL_T, cell];
const wideArms: IrType[] = [NULL_T, cell, UNDEFINED_T];

test("widening a nullable element maps its NULL to the null sentinel", () => {
  expect(pointerRetypeSteps(narrow, wide, narrowArms, wideArms, [0, 1])).toEqual([
    { from: "null", to: "sentinel" },
  ]);
});

test("narrowing maps the sentinel back to NULL", () => {
  expect(pointerRetypeSteps(wide, narrow, wideArms, narrowArms, [0, 1])).toEqual([
    { from: "sentinel", to: "null" },
  ]);
});

test("equal unit encodings need no select", () => {
  expect(
    pointerRetypeSteps(narrow, { ...narrow, unionId: "same" }, narrowArms, narrowArms, [0, 1]),
  ).toEqual([]);
});

test("a conversion that has to rebuild an arm stays off the direct map", () => {
  // The reference arms differ.
  const otherArm = { ...wide, arm: other };
  expect(
    pointerRetypeSteps(narrow, otherArm, narrowArms, [NULL_T, other, UNDEFINED_T], [0, 1]),
  ).toBeNull();
  // A listed tag no longer holds the same arm.
  expect(pointerRetypeSteps(narrow, wide, narrowArms, wideArms, [0, 2])).toBeNull();
  // A tag past the source's arms.
  expect(pointerRetypeSteps(narrow, wide, narrowArms, wideArms, [0, 1, 2])).toBeNull();
});

test("shape and class unions keep their rebuild path", () => {
  const shapes = {
    repr: "shapes" as const,
    unionId: "shapes",
    unitTag: 0,
    nullTag: -1,
    arms: [{ tag: 1, shapeId: "cell" }],
  };
  expect(pointerRetypeSteps(shapes, narrow, [cell], narrowArms, [1])).toBeNull();
});

test("the emitted conversion selects on the source encoding", () => {
  const B = new BlockBuilder();
  const steps: PointerRetypeStep[] = [{ from: "null", to: "sentinel" }];
  const value = emitPointerRetype(B, "%v", steps);
  const text = B.render();
  expect(text).toContain("= icmp eq ptr %v, null");
  expect(text).toContain("= select i1 %t0, ptr @sc_nullable_null, ptr %v");
  expect(value).toBe("%t1");
  expect(emitPointerRetype(B, "%w", [])).toBe("%w");
});
