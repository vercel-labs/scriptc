// mock.getter and mock.setter on an object whose accessors the
// checked-dynamic property machinery serves: the mock becomes the accessor
// (Node redefines the property, keeping the original descriptor), every read
// and write goes through it, and restore() puts the original accessor back.
// The accessor is found along the prototype chain, and a missing one (a data
// property, or the opposite half of an accessor pair) throws Node's
// ERR_INVALID_ARG_VALUE before the mock exists.
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

test("inherited accessor", () => {
  const proto: any = {
    get inherited(): number {
      return 5;
    },
    set inherited(x: number) {},
  };
  const child: any = Object.create(proto);
  const spy = mock.getter(child, "inherited", () => 7);
  assert.strictEqual(child.inherited, 7);
  spy.mock.restore();
  assert.strictEqual(child.inherited, 5);
});

const getterOnly: any = {
  get onlyGetter(): number {
    return 1;
  },
};
const setterOnly: any = {
  set onlySetter(x: number) {},
};
const data: any = { value: 1 };

const restorable: any = {
  get accessor(): number {
    return 1;
  },
  set accessor(x: number) {},
};

test("implementation argument evaluates before the accessor lookup", () => {
  const order: string[] = [];
  const spy = mock.getter(
    restorable,
    "accessor",
    (() => {
      order.push("implementation");
      // The implementation argument's side effects run before Node reads the
      // accessor, so the mock captures this redefined descriptor.
      Object.defineProperty(restorable, "accessor", {
        configurable: true,
        get() {
          return 9;
        },
      });
      return () => 42;
    })(),
  );
  assert.deepStrictEqual(order, ["implementation"]);
  assert.strictEqual(restorable.accessor, 42);
  assert.strictEqual(spy.mock.callCount(), 1);
  spy.mock.restore();
  assert.strictEqual(restorable.accessor, 9);
});

test("a rejected mock still evaluates its implementation argument", () => {
  const calls: string[] = [];
  assert.throws(
    () => {
      mock.getter(
        data,
        "value",
        (() => {
          calls.push("evaluated");
          return () => 1;
        })(),
      );
    },
    {
      name: "TypeError",
      code: "ERR_INVALID_ARG_VALUE",
      message: "The argument 'methodName' must be a method. Received undefined",
    },
  );
  assert.deepStrictEqual(calls, ["evaluated"]);
});

test("missing accessor throws", () => {
  const expected = {
    name: "TypeError",
    code: "ERR_INVALID_ARG_VALUE",
    message: "The argument 'methodName' must be a method. Received undefined",
  };
  assert.throws(() => {
    mock.setter(getterOnly, "onlyGetter", (x: number) => {});
  }, expected);
  assert.throws(() => {
    mock.getter(setterOnly, "onlySetter", () => 1);
  }, expected);
  assert.throws(() => {
    mock.getter(data, "value", () => 1);
  }, expected);
});
