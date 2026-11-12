import { test } from "node:test";
import assert from "node:assert/strict";

console.log("passing fixture");

test("adds", () => {
  assert.equal(1 + 1, 2);
});

test("concatenates", () => {
  assert.equal("a" + "b", "ab");
});
