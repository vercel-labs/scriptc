// @exit: 1
// A test that times out cancels its subtests that are still running, the
// innermost first, with "test did not finish before its parent and was
// cancelled". Subtests that finished keep their results, and the
// cancelled bodies report nothing when they settle later.
import { test } from "node:test";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("parent", { timeout: 40 }, async (t) => {
  await t.test("finished first", () => {});
  await t.test("running", async (t) => {
    await t.test("inner done", () => {});
    await t.test("inner running", async () => {
      await sleep(300);
      throw new Error("never reported");
    });
  });
});

test("next", async () => {
  await sleep(400);
});
