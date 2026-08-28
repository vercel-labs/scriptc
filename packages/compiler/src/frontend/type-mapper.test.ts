/* tupleShapeOf is the SC0004 panic guard's narrowing for tuple-position
 * checker shapes (2726): a direct tuple shape answers itself, a TypeReference
 * resolves its target, anything else — or a checker PANIC on that target
 * round-trip (the checker.TypeData-is-*TypeReference interface-conversion
 * family) — answers undefined so the mapping degrades to an actionable
 * unsupported-shape diagnostic instead of crashing the compile. These tests
 * pin the narrowing against synthetic shapes; the poisoned-facade end of the
 * fence lives in test/ts7/facade.test.ts. */

import { expect, test } from "vitest";
import { tupleShapeOf } from "./type-mapper.js";
import type { Type } from "./ts7/adapter.js";

interface FakeShape {
  elementFlags?: readonly number[];
  isRef?: boolean;
  target?: unknown;
  targetThrows?: unknown;
}

function fakeType(opts: FakeShape): Type {
  return {
    elementFlags: opts.elementFlags,
    isTypeReference: () => opts.isRef ?? false,
    getTarget: () => {
      if (opts.targetThrows !== undefined) throw opts.targetThrows;
      return opts.target;
    },
  } as unknown as Type;
}

const PAIR_FLAGS = [3, 3];

test("a direct tuple shape answers itself without a target round-trip", () => {
  const shape = fakeType({ elementFlags: PAIR_FLAGS, targetThrows: new Error("must not query") });
  expect(tupleShapeOf(shape)).toBe(shape);
});

test("a TypeReference resolves its target and reads elementFlags there", () => {
  const target = fakeType({ elementFlags: PAIR_FLAGS });
  const ref = fakeType({ isRef: true, target });
  expect(tupleShapeOf(ref)).toBe(target);
});

test("a tuple-true non-reference answers undefined without querying the target", () => {
  const shape = fakeType({ isRef: false, targetThrows: new Error("must not query") });
  expect(tupleShapeOf(shape)).toBeUndefined();
});

test("a checker panic on the target round-trip degrades to undefined", () => {
  const ref = fakeType({
    isRef: true,
    targetThrows: new Error(
      "panic: interface conversion: checker.TypeData is *checker.TypeReference, not checker.TupleType",
    ),
  });
  expect(tupleShapeOf(ref)).toBeUndefined();
});

test("a non-checker error on the target round-trip is not swallowed", () => {
  const ref = fakeType({ isRef: true, targetThrows: new Error("connection lost") });
  expect(() => tupleShapeOf(ref)).toThrowError("connection lost");
});
