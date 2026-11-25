// A custom assertion that replaces its own registration while it runs: the
// running function keeps its captured state to the end of the call, and the
// assertion set a test uses is the registry as that test first reached
// `t.assert` (Node builds the test's assertion object at that moment), so a
// later test sees the replacement and a registration made after the first
// read stays out of that test's way.
import assert from "node:assert";
import { assert as testAssert, test } from "node:test";

function install(): void {
  const state: string[] = ["captured"];
  testAssert.register("reentrant", () => {
    testAssert.register("reentrant", () => "replaced");
    state.push("after");
    assert.deepStrictEqual(state, ["captured", "after"]);
    return state.join("+");
  });
}

install();

test("a re-registered assertion keeps its captured state", (t) => {
  assert.strictEqual(t.assert.reentrant(), "captured+after");
});

test("a later test reaches the replacement", (t) => {
  assert.strictEqual(t.assert.reentrant(), "replaced");
});

test("an assertion registered before the first read is visible", (t) => {
  testAssert.register("early", () => "early");
  assert.strictEqual(t.assert.early(), "early");
});

test("one registered after the first read is not", (t) => {
  assert.strictEqual(t.assert.reentrant(), "replaced");
  testAssert.register("late", () => "late");
  assert.throws(() => t.assert.late(), /is not a function/);
});
