// @exit: 0
// t.test subtests with async bodies started inside a synchronous handler:
// then, catch and finally on an untyped promise, and then on a typed promise
// whose handler answers unknown. The handler's steps need a fiber for the
// subtest to wait on: one subtest body awaits a pending promise, one awaits
// nothing.
import assert from "node:assert";
import { test } from "node:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loose(v: unknown): any {
  return v;
}

function later<T>(v: T, ms: number): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));
}

test("async subtests from handlers", async (t) => {
  const order: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let viaThen: any = loose(Promise.resolve(2));
  viaThen = viaThen.then((v: number): number => {
    order.push("then");
    t.test("from an untyped then", async () => {
      const w = await later(v, 5);
      order.push("sub-then");
      assert.strictEqual(w, 2);
    });
    return v;
  });
  await viaThen;
  await later(0, 20);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let settled: any = loose(Promise.resolve(3));
  settled = settled.then((v: number): number => {
    order.push("settled");
    t.test("from an untyped then, nothing pending", async () => {
      order.push("sub-settled");
      assert.strictEqual(v, 3);
    });
    return v;
  });
  await settled;
  await later(0, 20);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let viaCatch: any = loose(Promise.reject(new Error("no")));
  viaCatch = viaCatch.catch((e: Error): string => {
    order.push("catch");
    t.test("from an untyped catch", async () => {
      const w = await later(e.message, 5);
      order.push("sub-catch");
      assert.strictEqual(w, "no");
    });
    return e.message;
  });
  await viaCatch;
  await later(0, 20);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let viaFinally: any = loose(Promise.resolve(4));
  viaFinally = viaFinally.finally((): void => {
    order.push("finally");
    t.test("from an untyped finally", async () => {
      const w = await later(4, 5);
      order.push("sub-finally");
      assert.strictEqual(w, 4);
    });
  });
  await viaFinally;
  await later(0, 20);

  await Promise.resolve(5).then((v): unknown => {
    order.push("unknown");
    t.test("from a reaction answering unknown", async () => {
      const w = await later(v, 5);
      order.push("sub-unknown");
      assert.strictEqual(w, 5);
    });
    return v;
  });
  await later(0, 20);

  assert.strictEqual(
    order.join(" "),
    "then sub-then settled sub-settled catch sub-catch finally sub-finally unknown sub-unknown",
  );
});
