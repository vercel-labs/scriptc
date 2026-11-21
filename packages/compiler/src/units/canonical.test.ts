import { expect, test } from "vitest";
import { canonicalJson, type CanonicalValue } from "./canonical.js";

test("sorts object keys and keeps array order", () => {
  expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
});

test("drops undefined members like JSON.stringify", () => {
  // The type forbids `undefined`; a value assembled elsewhere can still
  // hold one, and the serializer must drop it, not print null.
  const value = { a: undefined, b: 1 } as unknown as CanonicalValue;
  expect(canonicalJson(value)).toBe('{"b":1}');
});
