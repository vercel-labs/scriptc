// @exit: 1
// A registered assertion is an ordinary call: its value is the function's
// return value (Node's assertion object hands the result back), a discarded
// value is harmless, and a throw still fails the test.
import assert from "node:assert";
import { assert as testAssert, test } from "node:test";

testAssert.register("double", (value: number) => value * 2);
testAssert.register("isPositive", (value: number) => {
  assert.ok(value > 0, `${value} is not positive`);
  return "checked";
});

test("a registered assertion returns its function's value", (t) => {
  assert.strictEqual(t.assert.double(21), 42);
  assert.strictEqual(t.assert.isPositive(1), "checked");
});

test("a discarded assertion value is harmless", (t) => {
  t.assert.double(2);
  t.assert.isPositive(3);
});

test("a failed assertion still fails the test", (t) => {
  t.assert.isPositive(-1);
});
