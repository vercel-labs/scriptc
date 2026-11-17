// @exit: 1
// t.plan(count, { wait }): a test that ends short of its plan holds the
// test open for the assertions its timers still run, up to the wait. When
// they land, the test passes; when the window elapses, it is cancelled
// with Node's "plan timed out after <wait>ms with <n> assertions when
// expecting <plan>" message. A plan can be set once.
import { test } from "node:test";

test("wait is satisfied", (t) => {
  t.plan(2, { wait: 200 });
  t.assert.ok(true);
  setTimeout(() => {
    t.assert.strictEqual(1 + 1, 2);
  }, 5);
});

test("wait times out", (t) => {
  t.plan(2, { wait: 10 });
  t.assert.ok(true);
});

test("no wait fails at once", (t) => {
  t.plan(3);
  t.assert.ok(true);
});

test("plan once", (t) => {
  t.plan(1);
  try {
    t.plan(1);
  } catch (error) {
    t.assert.strictEqual((error as { code?: string }).code, "ERR_TEST_FAILURE");
  }
  t.assert.ok(true);
});
