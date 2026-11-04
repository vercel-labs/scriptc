// t.runOnly(true) makes the subtests registered under the test from that
// point run only when marked with { only }; false turns the filter off
// again, and subtests already registered keep the decision made for them.
import { describe, it, test } from "node:test";

test("runOnly(true) drops unmarked subtests", async (t) => {
  t.runOnly(true);
  await t.test("dropped", () => {});
  await t.test("kept", { only: true }, () => {});
  await t.test("also dropped", () => {});
  t.runOnly(false);
  await t.test("runs again", () => {});
});

describe("suite", () => {
  it("unaffected by a sibling's runOnly", async (t) => {
    t.runOnly(true);
    t.runOnly(false);
    await t.test("plain child", () => {});
  });
});

test("runOnly(true) with no marked subtest runs none", async (t) => {
  t.runOnly(true);
  await t.test("first", () => {});
  await t.test("second", () => {});
});

// Node's t.test() counts the subtest against the parent plan when it is
// called, before the runOnly filter drops it, so a dropped subtest still
// counts.
test("runOnly(true) counts a dropped subtest toward the plan", (t) => {
  t.plan(2);
  t.runOnly(true);
  t.test("dropped", () => {});
  t.test("kept", { only: true }, () => {});
});

// A bare test() call inside a concurrent body registers under the running
// test; the runOnly filter drops it there too, so its body never runs.
test("runOnly(true) filters a bare test under concurrency", { concurrency: true }, async (t) => {
  t.runOnly(true);
  test("bare dropped", () => {
    throw new Error("a filtered body ran");
  });
  await t.test("kept", { only: true }, () => {});
});
