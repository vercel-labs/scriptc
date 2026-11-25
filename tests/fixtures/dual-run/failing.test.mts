import { test } from "node:test";
import assert from "node:assert/strict";

test("passes", () => {
  assert.equal(2 * 3, 6);
});

test("fails", () => {
  assert.deepEqual({ a: 1 }, { a: 2 });
});
