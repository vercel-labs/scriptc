// The accessor mock's arguments evaluate the way Node's do: the
// implementation (or an undefined-answering expression, for its effects)
// and the { times } option run before the accessor is read, so an accessor
// they replace is the one the mock captures and restore() reinstates; a
// typed module-level accessor object supports the no-implementation form.
import assert from "node:assert";
import { mock, test } from "node:test";

let stored = 1;
const holder: any = {
  get v(): number {
    return stored;
  },
  set v(x: number) {
    stored = x;
  },
};

test("the times option evaluates before the accessor is read", () => {
  const before = holder.v;
  const spy = mock.getter(holder, "v", () => 42, {
    times: (Object.defineProperty(holder, "v", {
      configurable: true,
      get: () => 9,
      set: (x: number) => {
        stored = x;
      },
    }),
    1),
  });
  assert.strictEqual(before, 1);
  assert.strictEqual(holder.v, 42);
  // The budget ran out and the accessor the times expression installed is
  // back.
  assert.strictEqual(holder.v, 9);
  assert.strictEqual(spy.mock.callCount(), 1);
});

let typed = 1;
const typedHolder = {
  get u(): number {
    return typed;
  },
  set u(x: number) {
    typed = x;
  },
};

test("a typed module-level accessor without an implementation wraps the original", () => {
  const spy = mock.getter(typedHolder, "u");
  assert.strictEqual(typedHolder.u, 1);
  typed = 3;
  assert.strictEqual(typedHolder.u, 3);
  assert.strictEqual(spy.mock.callCount(), 2);
  spy.mock.restore();
});

test("an undefined-answering implementation keeps its effects", () => {
  const order: string[] = [];
  const spy = mock.getter(
    typedHolder,
    "u",
    (() => {
      order.push("implementation");
    })(),
  );
  assert.deepStrictEqual(order, ["implementation"]);
  assert.strictEqual(typedHolder.u, 3);
  assert.strictEqual(spy.mock.callCount(), 1);
  spy.mock.restore();
});
