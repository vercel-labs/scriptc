// mock.fn() and t.mock.fn() without an original: the mock returns
// undefined and records the arguments of each call, whatever its callers
// pass. mockImplementation and mockImplementationOnce replace its
// behavior, and restore() brings back the function that returns undefined.
// mock.fn<F>() records F's parameters, for a function type whose return
// type is void or includes undefined.
import assert from "node:assert";
import { mock, test } from "node:test";

test("records calls with any arguments", () => {
  const fn = mock.fn();
  fn(1, "two");
  fn();
  fn(true, null, [3]);
  assert.strictEqual(fn.mock.callCount(), 3);
  const [first, second, third] = fn.mock.calls;
  assert.deepStrictEqual(first!.arguments, [1, "two"]);
  assert.strictEqual(second!.arguments.length, 0);
  assert.deepStrictEqual(third!.arguments, [true, null, [3]]);
  assert.ok(first!.result === undefined);
  assert.ok(first!.error === undefined);
  assert.ok(first!.this === undefined);
});

test("changes implementations", () => {
  const seen: string[] = [];
  const fn = mock.fn();
  fn.mock.mockImplementation((...args: unknown[]) => {
    seen.push(`impl ${args.length}`);
    return undefined;
  });
  fn.mock.mockImplementationOnce(() => {
    seen.push("once");
    return undefined;
  });
  fn("a");
  fn("a", "b");
  fn.mock.restore();
  fn("c");
  assert.deepStrictEqual(seen, ["once", "impl 2"]);
  assert.strictEqual(fn.mock.callCount(), 3);
  fn.mock.resetCalls();
  assert.strictEqual(fn.mock.callCount(), 0);
});

test("records a throwing implementation", () => {
  const fn = mock.fn();
  fn.mock.mockImplementation(() => {
    throw new Error("boom");
  });
  assert.throws(() => fn(7), { message: "boom" });
  const call = fn.mock.calls[0]!;
  assert.deepStrictEqual(call.arguments, [7]);
  assert.ok(call.error instanceof Error);
});

test("t.mock.fn() and typed mock.fn<F>()", (t) => {
  const fn = t.mock.fn();
  fn("x");
  assert.strictEqual(fn.mock.callCount(), 1);
  const typed = t.mock.fn<(a: number, b: string) => void>();
  typed(1, "x");
  typed(2, "y");
  assert.strictEqual(typed.mock.callCount(), 2);
  assert.strictEqual(typed.mock.calls[1]!.arguments[0], 2);
  assert.strictEqual(typed.mock.calls[1]!.arguments[1], "y");
  const maybe = t.mock.fn<() => number | undefined>();
  assert.ok(maybe() === undefined);
  maybe.mock.mockImplementation(() => 4);
  assert.ok(maybe() === 4);
  assert.ok(maybe.mock.calls[1]!.result === 4);
});
