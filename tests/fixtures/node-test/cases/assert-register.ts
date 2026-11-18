// @exit: 1
// node:test's assert.register adds an assertion to every TestContext: the
// registered function runs with the call's arguments, its throws fail the
// test like any assertion, and the call counts against t.plan.
import assert from "node:assert";
import { assert as testAssert, test } from "node:test";

testAssert.register("isEven", function (value: number) {
  assert.strictEqual(value % 2, 0, `${value} is not even`);
});

test("custom assertion passes", (t) => {
  t.assert.isEven(4);
  t.assert.isEven(2);
});

test("custom assertion counts toward the plan", (t) => {
  t.plan(1);
  t.assert.isEven(6);
});

test("custom assertion fails", (t) => {
  t.assert.isEven(3);
});
