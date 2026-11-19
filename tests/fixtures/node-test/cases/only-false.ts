// An explicit { only: false } filters the test, subtest or suite out of an
// in-process run: Node's only-filter always runs there, so the flagged test
// never starts and never reports — even with no `only` test beside it — and
// a filtered suite's collection callback does not run either, so its side
// effects never happen.
import assert from "node:assert";
import { describe, it, test } from "node:test";

test("kept", () => {});
test("dropped", { only: false }, () => {
  throw new Error("a filtered test does not run");
});
test.skip("dropped skip", { only: false }, () => {});
let filteredSuiteRan = false;
describe("dropped suite", { only: false }, () => {
  filteredSuiteRan = true;
  it("never collected", () => {});
});
describe("kept suite", () => {
  it("kept child", () => {});
  it("dropped child", { only: false }, () => {});
});
test("a filtered suite's body never runs", () => {
  assert.strictEqual(filteredSuiteRan, false);
});

test("subtests", async (t) => {
  await t.test("kept subtest", () => {});
  await t.test("dropped subtest", { only: false }, () => {
    throw new Error("a filtered subtest does not run");
  });
});
