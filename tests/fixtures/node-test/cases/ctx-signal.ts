// @exit: 1
// t.signal is the test's AbortSignal: unaborted in the body and in the
// beforeEach/afterEach hooks, the same signal on every read, aborted once
// the test finished or timed out (Node aborts its controller in the test's
// finally), and a suite's own signal in a describe body.
import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

let finished: AbortSignal | null = null;
let suiteSignal: AbortSignal | null = null;

test("lifecycle", (t) => {
  finished = t.signal;
  assert.strictEqual(t.signal === t.signal, true);
  assert.strictEqual(t.signal.aborted, false);
});

test("after finish", (t) => {
  assert.strictEqual(finished === null, false);
  assert.strictEqual(finished?.aborted, true);
  assert.strictEqual(t.signal.aborted, false);
});

beforeEach((t) => {
  assert.strictEqual(t.signal.aborted, false);
});

afterEach((t) => {
  assert.strictEqual(t.signal.aborted, t.name === "times out");
});

test("times out", { timeout: 20 }, async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  });
});

describe("suite", (s) => {
  suiteSignal = s.signal;
  assert.strictEqual(s.signal.aborted, false);
  test("child", () => {});
});

test("suite signal stays unaborted", () => {
  assert.strictEqual(suiteSignal === null, false);
  assert.strictEqual(suiteSignal?.aborted, false);
});
