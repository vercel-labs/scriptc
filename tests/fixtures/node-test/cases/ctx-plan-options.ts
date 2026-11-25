// @exit: 1
// t.plan's count validation (Node's validateUint32: an integer in
// 0..4294967295, ERR_OUT_OF_RANGE otherwise) and its { wait } forms:
// `true` waits until the plan is met, `false` (Node's default) checks as
// soon as the body finishes and fails a shortfall at once.
import assert from "node:assert";
import { test } from "node:test";

test("wait true is satisfied", (t) => {
  t.plan(2, { wait: true });
  t.assert.ok(true);
  setTimeout(() => {
    t.assert.strictEqual(1 + 1, 2);
  }, 5);
});

test("wait false checks at once", (t) => {
  t.plan(2, { wait: false });
  t.assert.ok(true);
});

test("the option plan blocks t.plan", { plan: 1 }, (t) => {
  let message = "";
  try {
    t.plan(1);
  } catch (error) {
    const e = error as { code: string; message: string };
    message = `${e.code} ${e.message}`;
  }
  t.assert.ok(true);
  assert.strictEqual(message, "ERR_TEST_FAILURE cannot set plan more than once");
});

test("a zero option plan installs none", { plan: 0 }, (t) => {
  t.assert.ok(true);
  t.assert.ok(true);
});

test("count validation", (t) => {
  const errors: string[] = [];
  for (const count of [-1, 1.5, 2 ** 32]) {
    try {
      t.plan(count);
    } catch (error) {
      const e = error as { name: string; code: string; message: string };
      errors.push(`${e.name} ${e.code} ${e.message}`);
    }
  }
  assert.deepStrictEqual(errors, [
    'RangeError ERR_OUT_OF_RANGE The value of "count" is out of range. It must be >= 0 && <= 4294967295. Received -1',
    'RangeError ERR_OUT_OF_RANGE The value of "count" is out of range. It must be an integer. Received 1.5',
    'RangeError ERR_OUT_OF_RANGE The value of "count" is out of range. It must be >= 0 && <= 4294967295. Received 4294967296',
  ]);
  t.plan(0);
});
