// @exit: 1
// A subtest a concurrent sibling's leftover timer registers after its own
// test finished: Node attaches it to the root and reports its failure when
// the run ends, after the parent's buffered subtree, rather than losing the
// line to the concurrent reporting.
import { test } from "node:test";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("parent", { concurrency: 2 }, async (t) => {
  await t.test("child", (c) => {
    setTimeout(() => {
      c.test("late child", () => {});
    }, 10);
  });
  await t.test("sibling", async () => {
    await sleep(40);
  });
});
