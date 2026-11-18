// @exit: 1
// t.plan(count, { wait: true }) waits for the plan, but the test's
// { timeout } still bounds the wait, as Node races the plan promise against
// its stopTest timer: an assertion that never arrives ends the test with
// the timeout failure instead of waiting forever. A numeric wait is bounded
// the same way, so the timeout wins when it elapses first.
import { test } from "node:test";

test("wait true times out", { timeout: 30 }, (t) => {
  t.plan(2, { wait: true });
  t.assert.ok(true);
});

test("wait true met before the timeout", { timeout: 500 }, (t) => {
  t.plan(2, { wait: true });
  t.assert.ok(true);
  setTimeout(() => {
    t.assert.ok(true);
  }, 5);
});

test("numeric wait bounded by the timeout", { timeout: 10 }, (t) => {
  t.plan(2, { wait: 200 });
  t.assert.ok(true);
});
