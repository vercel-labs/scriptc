// mock.getter and mock.setter on an object whose accessors the
// checked-dynamic property machinery serves: the mock becomes the accessor
// (Node redefines the property, keeping the original descriptor), every read
// and write goes through it, and restore() puts the original accessor back.
import assert from "node:assert";
import { mock, test } from "node:test";

const seen: string[] = [];
const holder = {
  _v: 1,
  get v(): number {
    return this._v;
  },
  set v(x: number) {
    this._v = x;
  },
};

test("getter", () => {
  const spy = mock.getter(holder, "v", () => 42);
  assert.strictEqual(holder.v, 42);
  assert.strictEqual(holder.v, 42);
  assert.strictEqual(spy.mock.callCount(), 2);
  spy.mock.restore();
  assert.strictEqual(holder.v, 1);
});

test("setter", () => {
  const spy = mock.setter(holder, "v", (x: number) => {
    seen.push(`set ${x}`);
  });
  holder.v = 7;
  assert.deepStrictEqual(seen, ["set 7"]);
  assert.strictEqual(spy.mock.callCount(), 1);
  assert.deepStrictEqual(spy.mock.calls[0]!.arguments, [7] as [number]);
  spy.mock.restore();
  holder.v = 9;
  assert.strictEqual(holder._v, 9);
});

test("times", () => {
  const spy = mock.getter(holder, "v", () => 5, { times: 1 });
  assert.strictEqual(holder.v, 5);
  assert.strictEqual(holder.v, 9);
  // The { times } budget restores the original accessor, so later reads
  // bypass the mock.
  assert.strictEqual(spy.mock.callCount(), 1);
});
