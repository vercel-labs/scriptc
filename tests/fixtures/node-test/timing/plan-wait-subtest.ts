// A plan's { wait } ends when the count is met, including by a subtest a
// timer registers: the test must not sit out the whole window. The lanes
// report this shape differently (a compiled subtest runs inline, so it
// finishes before the plan is judged, where Node cancels it), so only the
// wall clock is compared for it.
import { test } from "node:test";

test("waits for a subtest from a timer", (t) => {
  t.plan(1, { wait: 5000 });
  setTimeout(() => {
    t.test("from timer", () => {});
  }, 5);
});
