// mock.method and t.mock.method on records: the object's field becomes the
// mock, calls through it record the object as `this`, restore() writes the
// original back while the mock keeps its implementation, and a second mock
// of the same field restores the first. mock.restoreAll restores every mock
// the tracker made, mock.fn mocks included, in creation order; mock.reset
// restores them and forgets them, keeping their calls. t.mock restores its
// mocks when the test ends, after its t.after hooks.
import assert from "node:assert";
import { mock, test } from "node:test";

interface Store {
  get(key: string): string;
  size: number;
}

const seen: string[] = [];

test("mocks a method", () => {
  const counter = { step: 2, next: (n: number) => n + 2 };
  const original = counter.next;
  const next = mock.method(counter, "next");
  assert.strictEqual(counter.next(1), 3);
  assert.strictEqual(next.mock.callCount(), 1);
  const [first] = next.mock.calls;
  assert.deepStrictEqual(first!.arguments, [1] as [number]);
  assert.ok(first!.result === 3);
  assert.ok(first!.this === counter);
  assert.strictEqual(next(5), 7);
  assert.ok(next.mock.calls[1]!.this === undefined);
  next.mock.mockImplementation((n) => n * 10);
  assert.strictEqual(counter.next(2), 20);
  next.mock.restore();
  assert.ok(counter.next === original);
  assert.strictEqual(counter.next(2), 4);
  assert.strictEqual(next(3), 30);
  assert.strictEqual(next.mock.callCount(), 4);
});

test("an implementation and an interface-typed object", () => {
  const store: Store = { get: (key) => `value of ${key}`, size: 1 };
  const get = mock.method(store, "get", (key: string) => `mocked ${key}`);
  assert.strictEqual(store.get("a"), "mocked a");
  get.mock.mockImplementationOnce((key) => `once ${key}`);
  assert.strictEqual(store.get("b"), "once b");
  assert.strictEqual(store.get("c"), "mocked c");
  assert.deepStrictEqual(
    get.mock.calls.map((c) => c.arguments[0]),
    ["a", "b", "c"],
  );
  get.mock.restore();
  assert.strictEqual(store.get("d"), "value of d");
});

test("a second mock of the same method", () => {
  const box = { read: () => 1 };
  const outer = mock.method(box, "read", () => 2);
  const inner = mock.method(box, "read", () => 3);
  assert.strictEqual(box.read(), 3);
  assert.strictEqual(outer.mock.callCount(), 0);
  outer.mock.restore();
  assert.strictEqual(box.read(), 1);
  inner.mock.restore();
  assert.strictEqual(box.read(), 2);
  assert.strictEqual(outer.mock.callCount(), 1);
  assert.strictEqual(inner.mock.callCount(), 1);
});

test("a throwing implementation", () => {
  const parser = { parse: (text: string): number => Number(text) };
  const failure = new Error("bad input");
  const parse = mock.method(parser, "parse", (text: string): number => {
    if (text === "") throw failure;
    return text.length;
  });
  assert.throws(() => parser.parse(""), failure);
  assert.strictEqual(parser.parse("abc"), 3);
  assert.ok(parse.mock.calls[0]!.error === failure);
  assert.ok(parse.mock.calls[0]!.result === undefined);
  assert.ok(parse.mock.calls[1]!.result === 3);
});

test("mock.restoreAll and mock.reset", () => {
  const box = { read: () => 1, write: (n: number): void => {} };
  const read = mock.method(box, "read", () => 2);
  mock.method(box, "write", (n: number): void => {
    seen.push(`write ${n}`);
  });
  const double = mock.fn(
    (n: number) => n * 2,
    (n: number) => n * 3,
  );
  box.write(1);
  assert.strictEqual(box.read(), 2);
  assert.strictEqual(double(2), 6);
  mock.restoreAll();
  box.write(2);
  assert.strictEqual(box.read(), 1);
  assert.strictEqual(double(2), 4);
  assert.strictEqual(read.mock.callCount(), 1);
  box.read = read;
  mock.restoreAll();
  assert.strictEqual(box.read(), 1);
  const again = mock.method(box, "read", () => 5);
  assert.strictEqual(box.read(), 5);
  mock.reset();
  assert.strictEqual(box.read(), 1);
  assert.strictEqual(again.mock.callCount(), 1);
  box.read = again;
  mock.restoreAll();
  assert.strictEqual(box.read(), 5);
  assert.deepStrictEqual(seen, ["write 1"]);
});

const shared = { now: () => 0 };

test("t.mock restores when the test ends", (t) => {
  t.mock.method(shared, "now", () => 42);
  const later = t.mock.fn(
    (n: number) => n,
    (n: number) => -n,
  );
  t.after(() => {
    seen.push(`after hook ${shared.now()}`);
  });
  assert.strictEqual(shared.now(), 42);
  assert.strictEqual(later(1), -1);
});

test("the next test sees the original", () => {
  assert.strictEqual(shared.now(), 0);
  assert.deepStrictEqual(seen, ["write 1", "after hook 42"]);
});

test("t.mock.restoreAll and t.mock.reset", (t) => {
  const box = { read: () => 1 };
  const read = t.mock.method(box, "read", () => 2);
  t.mock.restoreAll();
  assert.strictEqual(box.read(), 1);
  box.read = read;
  t.mock.reset();
  assert.strictEqual(box.read(), 1);
  box.read = read;
  t.mock.restoreAll();
  assert.strictEqual(box.read(), 2);
});

test("subtests have their own tracker", async (t) => {
  await t.test("inner", (t) => {
    t.mock.method(shared, "now", () => 7);
    assert.strictEqual(shared.now(), 7);
  });
  assert.strictEqual(shared.now(), 0);
});

test("methods that read this, on records, instances, and prototypes", () => {
  interface Counter {
    base: number;
    add(n: number): number;
  }
  const counter: Counter = {
    base: 2,
    add(n: number) {
      this.base += n;
      return this.base;
    },
  };
  const add = mock.method(counter, "add", (n: number) => n * 2);
  assert.strictEqual(counter.add(3), 6);
  assert.strictEqual(counter.base, 2);
  assert.ok(add.mock.calls[0]!.this === counter);
  add.mock.restore();
  assert.strictEqual(counter.add(3), 5);
});

class Greeter {
  greeting = "hi";
  greet(name: string): string {
    return `${this.greeting} ${name}`;
  }
}

test("class instances and prototype objects", () => {
  const greeter = new Greeter();
  const greet = mock.method(greeter, "greet", (name: string) => `mocked ${name}`);
  assert.strictEqual(greeter.greet("x"), "mocked x");
  assert.ok(greet.mock.calls[0]!.this === greeter);
  greet.mock.restore();
  assert.strictEqual(greeter.greet("x"), "hi x");

  const proto = mock.method(
    Greeter.prototype,
    "greet",
    function (this: Greeter, name: string) {
      return `proto ${name} ${this.greeting}`;
    },
  );
  assert.strictEqual(new Greeter().greet("y"), "proto y hi");
  // The restored instance kept its own method, so the prototype replacement
  // does not reach it.
  assert.strictEqual(greeter.greet("z"), "hi z");
  assert.strictEqual(proto.mock.callCount(), 1);
  proto.mock.restore();
  assert.strictEqual(new Greeter().greet("y"), "hi y");
});
