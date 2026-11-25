// @exit: 1
// t.plan(count, { wait: true }) waits for the plan, but the test's
// { timeout } still bounds the wait, as Node races the plan promise against
// its stopTest timer: an assertion that never arrives ends the test with
// the timeout failure instead of waiting forever. A numeric wait is bounded
// the same way, so the timeout wins when it elapses first.
import { tracingChannel } from "node:diagnostics_channel";
import { test } from "node:test";

/* The timeout that ends a plan wait is the test's failure, so tracing
 * subscribers get Node's error event for it. */
const failures: string[] = [];
tracingChannel("node.test").subscribe({
  error(ctx: object) {
    const info = ctx as { name: string; error?: { message?: string } };
    const message = info.error?.message ?? "";
    failures.push(`${info.name}: ${message.startsWith("test timed out after") ? "timeout" : message}`);
  },
});

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

test("check the timeout errors reached tracing", () => {
  const expected = ["wait true times out: timeout", "numeric wait bounded by the timeout: timeout"];
  if (failures.join("\n") !== expected.join("\n")) throw new Error(`errors:\n${failures.join("\n")}`);
});
