// A registration whose callback comes from a factory evaluates the factory
// once: the name and the registration share the one function value.
import assert from "node:assert";
import { test } from "node:test";

let calls = 0;

function makeBody(): () => void {
  calls += 1;
  return () => {};
}

test(makeBody());

test("the factory ran once", () => {
  assert.strictEqual(calls, 1);
});
