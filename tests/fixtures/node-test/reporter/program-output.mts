// @exit: 1
/* A node:test program that prints outside its tests, so a lane with the
 * report sent elsewhere keeps program stdout on stdout. One test fails, so
 * exit code, the passing line and the failing-tests section all appear. */
import { test } from "node:test";
import assert from "node:assert/strict";

console.log("before tests");

test("passes", () => {
  assert.equal(1 + 1, 2);
});

test("fails", () => {
  assert.equal("actual", "expected");
});

console.log("after tests");
