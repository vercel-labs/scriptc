// Module-level before hooks run at their before() calls, with the root's
// context (named "<root>"), and the first top-level test waits for the
// async ones; module-level after hooks run after the last top-level test
// or suite, and module-level beforeEach hooks run before each test, with
// that test's context.
import { after, before, beforeEach, describe, it, test } from "node:test";
import * as assert from "node:assert";

const seen: string[] = [];

before((c) => {
  seen.push(`before: ${c.name}`);
});
seen.push("after the before() call");
before(async () => {
  seen.push("async before starts");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  seen.push("async before ends");
});
beforeEach((c) => {
  seen.push(`beforeEach: ${c.name}`);
});
after(() => {
  // Throws, and so fails the run visibly, unless every hook ran in order.
  assert.deepStrictEqual(seen, [
    "before: <root>",
    "after the before() call",
    "async before starts",
    "suite body",
    "async before ends",
    "beforeEach: x",
    "beforeEach: t",
    "report",
  ]);
});

describe("s", () => {
  seen.push("suite body");
  it("x", () => {});
});

test("t", () => {
  seen.push("report");
});
