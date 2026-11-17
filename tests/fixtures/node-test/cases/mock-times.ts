// mock.fn and mock.method { times }: the mock's implementation serves the
// given number of calls, and the call that reaches the count restores the
// original first, so the next call runs it. The count is validated when the
// mock is made (Node's non-negative-integer rule, ERR_OUT_OF_RANGE). A
// method's options object without an implementation keeps the original.
import assert from "node:assert";
import { mock, test } from "node:test";

test("fn times restores after the count", () => {
  const f = mock.fn((x: number) => x, (x: number) => x + 100, { times: 2 });
  assert.strictEqual(f(1), 101);
  assert.strictEqual(f(2), 102);
  assert.strictEqual(f(3), 3);
  assert.strictEqual(f.mock.callCount(), 3);
});

test("fn times with the original as implementation", () => {
  const f = mock.fn((x: number) => x * 2, { times: 1 });
  assert.strictEqual(f(1), 2);
  assert.strictEqual(f(2), 4);
});

test("method times restores the field", () => {
  const obj = { m: (x: number) => `orig${x}` };
  const m = mock.method(obj, "m", (x: number) => `mock${x}`, { times: 2 });
  assert.strictEqual(obj.m(1), "mock1");
  assert.strictEqual(obj.m(2), "mock2");
  assert.strictEqual(obj.m(3), "orig3");
  // The restored field is the original function: the call is not recorded.
  assert.strictEqual(m.mock.callCount(), 2);
});

test("method options only keeps the original", () => {
  const obj = { m: (x: number) => `orig${x}` };
  mock.method(obj, "m", { times: 1 });
  assert.strictEqual(obj.m(1), "orig1");
  assert.strictEqual(obj.m(2), "orig2");
});

test("Infinity is unlimited", () => {
  const f = mock.fn((x: number) => x, (x: number) => x + 1, { times: Infinity });
  assert.strictEqual(f(1), 2);
  assert.strictEqual(f(2), 3);
  assert.strictEqual(f.mock.callCount(), 2);
  const obj = { m: (x: number) => `orig${x}` };
  const m = mock.method(obj, "m", (x: number) => `mock${x}`, { times: Infinity });
  assert.strictEqual(obj.m(1), "mock1");
  assert.strictEqual(obj.m(2), "mock2");
  assert.strictEqual(m.mock.callCount(), 2);
});

test("arguments evaluate before the options", () => {
  let order: string[] = [];
  const make = (tag: string, value: number) => {
    order.push(tag);
    return (x: number) => `${tag}${x + value}`;
  };
  const f = mock.fn(make("a", 100), make("b", 200), { times: order.length + 2 });
  const results = [f(0), f(0), f(0), f(0), f(0)];
  assert.deepStrictEqual(order, ["a", "b"]);
  assert.deepStrictEqual(results, ["b200", "b200", "b200", "b200", "a100"]);
});

test("method arguments evaluate before the options", () => {
  let count = 0;
  const make = (value: number) => {
    count++;
    return (x: number) => x + value;
  };
  const obj = { m: (x: number) => x };
  mock.method(obj, "m", make(200), { times: count + 2 });
  const results = [obj.m(0), obj.m(0), obj.m(0), obj.m(0)];
  assert.deepStrictEqual(results, [200, 200, 200, 0]);
});

test("times is validated when the mock is made", () => {
  for (const times of [0, -1, 1.5]) {
    assert.throws(
      () => mock.fn((x: number) => x, { times }),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
});
