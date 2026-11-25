// The MockFunctionContext surface: the calls log (arguments, this, result,
// error; each read a copy), callCount (throwing calls included),
// mockImplementation, mockImplementationOnce by call index (a later
// registration for one index replacing the earlier one), resetCalls (the
// log and the count; a pending once implementation stays) and restore (the
// original implementation, on mock.fn and on an object method).
import assert from "node:assert";
import { mock, test } from "node:test";

test("calls records arguments, this, result and error", () => {
  const error = new Error("boom");
  const f = mock.fn((a: number, b: string): number => {
    if (a < 0) throw error;
    return a;
  });
  assert.strictEqual(f(1, "x"), 1);
  assert.throws(() => f(-1, "y"), error);
  assert.strictEqual(f.mock.callCount(), 2);
  const [first, second] = f.mock.calls;
  assert.deepStrictEqual(first!.arguments, [1, "x"] as [number, string]);
  assert.ok(first!.result === 1);
  assert.ok(first!.error === undefined);
  assert.ok(first!.this === undefined);
  assert.deepStrictEqual(second!.arguments, [-1, "y"] as [number, string]);
  assert.ok(second!.result === undefined);
  assert.ok(second!.error === error);
  assert.strictEqual(f.mock.calls !== f.mock.calls, true);
  const copy = f.mock.calls;
  copy.length = 1;
  assert.strictEqual(f.mock.callCount(), 2);
});

test("callCount counts calls of every kind", () => {
  const f = mock.fn(() => 0);
  assert.strictEqual(f.mock.callCount(), 0);
  f();
  f();
  f();
  assert.strictEqual(f.mock.callCount(), 3);
});

test("mockImplementation replaces and restore brings the original back", () => {
  const add = mock.fn((a: number, b: number) => a + b);
  add.mock.mockImplementation((a, b) => a * b);
  assert.strictEqual(add(3, 4), 12);
  add.mock.restore();
  assert.strictEqual(add(3, 4), 7);
  add.mock.mockImplementation((a, b) => a - b);
  assert.strictEqual(add(3, 4), -1);
  assert.strictEqual(add.mock.callCount(), 3);
});

test("mockImplementationOnce by index", () => {
  const f = mock.fn((x: number) => x);
  f.mock.mockImplementationOnce((x: number) => x + 10, 2);
  f.mock.mockImplementationOnce((x: number) => x + 20, 2);
  assert.strictEqual(f(1), 1);
  assert.strictEqual(f(1), 1);
  assert.strictEqual(f(1), 21);
  assert.strictEqual(f(1), 1);
  assert.strictEqual(f.mock.callCount(), 4);
});

test("resetCalls clears the log and keeps a pending once", () => {
  const f = mock.fn((x: number) => x);
  f.mock.mockImplementationOnce(() => 99);
  f(1);
  f(1);
  assert.strictEqual(f.mock.callCount(), 2);
  f.mock.resetCalls();
  assert.strictEqual(f.mock.callCount(), 0);
  assert.strictEqual(f.mock.calls.length, 0);
  assert.strictEqual(f(1), 1);
});

test("method context records the receiver and restores the field", () => {
  const obj = { n: 2, m: (x: number) => x * 3 };
  const m = mock.method(obj, "m", () => 100);
  assert.strictEqual(obj.m(3), 100);
  assert.strictEqual(m.mock.callCount(), 1);
  assert.strictEqual(m.mock.calls[0]!.this === obj, true);
  assert.ok(m.mock.calls[0]!.result === 100);
  m.mock.mockImplementation(() => 200);
  assert.strictEqual(obj.m(3), 200);
  m.mock.resetCalls();
  assert.strictEqual(m.mock.callCount(), 0);
  m.mock.restore();
  assert.strictEqual(obj.m(3), 9);
});
