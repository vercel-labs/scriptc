// mock.getter/mock.setter without an implementation (or with an explicit
// undefined): Node wraps the original accessor, so reads and writes pass
// through and still count, and restore() puts the accessor back.
import assert from "node:assert";
import { mock, test } from "node:test";

test("a setter given an explicit undefined wraps the original", () => {
  let stored = 1;
  const obj = {
    get v(): number {
      return stored;
    },
    set v(x: number) {
      stored = x;
    },
  };
  const spy = mock.setter(obj, "v", undefined);
  obj.v = 9;
  assert.strictEqual(stored, 9);
  assert.strictEqual(spy.mock.callCount(), 1);
  spy.mock.restore();
  obj.v = 11;
  assert.strictEqual(stored, 11);
});

test("a getter without an implementation wraps the original", () => {
  let stored = 1;
  const obj = {
    get v(): number {
      return stored;
    },
    set v(x: number) {
      stored = x;
    },
  };
  const spy = mock.getter(obj, "v");
  assert.strictEqual(obj.v, 1);
  stored = 5;
  assert.strictEqual(obj.v, 5);
  assert.strictEqual(spy.mock.callCount(), 2);
  spy.mock.restore();
  assert.strictEqual(obj.v, 5);
});

test("a method given an explicit undefined wraps the original", () => {
  let seen = 0;
  const obj = {
    m(x: number): number {
      seen += 1;
      return x * 2;
    },
  };
  const spy = mock.method(obj, "m", undefined);
  assert.strictEqual(obj.m(3), 6);
  assert.strictEqual(seen, 1);
  assert.strictEqual(spy.mock.callCount(), 1);
  spy.mock.restore();
});
