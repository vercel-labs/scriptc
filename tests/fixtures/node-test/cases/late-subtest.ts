// @exit: 1
// A subtest a test's leftover timer registers after the test finished:
// Node attaches it to the root and fails it with "test could not be
// started because its parent finished" instead of running it. The runtime
// reports it on arrival, so it still lands ahead of the summary.
import { test } from "node:test";

test("parent", (t) => {
  setTimeout(() => {
    t.test("late child", () => {
      throw new Error("a late subtest does not run its body");
    });
  }, 5);
});

test("early sibling", () => {});
