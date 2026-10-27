// @exit: 1
// getTestContext() in the cleanup hooks of a subtest cancelled by its
// parent's timeout answers each hook's owner, as Node does: the suite for
// its afterEach, the parent test for its t.afterEach, and the cancelled
// subtest for its own t.after.
import { afterEach, describe, getTestContext, it, test } from "node:test";
import * as assert from "node:assert";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const seen: string[] = [];

function record(where: string): void {
  seen.push(`${where}: ${getTestContext()?.fullName ?? "undefined"}`);
}

describe("suite", () => {
  afterEach((c) => record(`suite afterEach for ${c.name}`));

  it("parent", { timeout: 30 }, async (t) => {
    t.afterEach((c) => record(`parent afterEach for ${c.name}`));
    await t.test("sub", async (u) => {
      u.after(() => record("sub after"));
      record("sub body");
      await sleep(200);
      record("sub settles");
    });
  });
});

test("next", async () => {
  await sleep(300);
  assert.deepStrictEqual(seen, [
    "sub body: suite > parent > sub",
    "suite afterEach for parent: suite",
    "parent afterEach for sub: suite > parent",
    "suite afterEach for sub: suite",
    "sub after: suite > parent > sub",
    "sub settles: suite > parent > sub",
  ]);
});
