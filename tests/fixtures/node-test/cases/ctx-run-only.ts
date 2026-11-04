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
