// @exit: 1
// The afterEach hooks of a test aborted through its { signal } run while the
// test's teardown settles, after a following test may have started; both
// hooks run, in registration order. This lives on its own rather than beside
// suite-signal's other aborted tests: when several aborts interleave, whether
// the hooks have run by the time a following test reads them is a race in
// the runner itself.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hookOrder: string[] = [];
const hookAbort = new AbortController();
describe("hooks after abort", () => {
  afterEach((t) => {
    hookOrder.push(`a1 ${t.name}`);
  });
  afterEach((t) => {
    hookOrder.push(`a2 ${t.name}`);
  });
  test("aborted", { signal: hookAbort.signal }, async () => {
    await sleep(50);
  });
});
setTimeout(() => hookAbort.abort(new Error("hook stop")), 5);

test("hooks ran", async (t) => {
  // Give the aborted test's teardown the time it takes to run both hooks
  // before reading them.
  await sleep(60);
  t.diagnostic(hookOrder.join(" | "));
  assert.deepStrictEqual(hookOrder, ["a1 aborted", "a2 aborted"]);
});
