// @exit: 1
// A project types its custom assertions itself, as an @types/node project
// does with a module augmentation (usually from the registered function's
// own return type). Node still hands the call the function's result: a
// `void` declaration does not stop `await` from adopting the assertion's
// promise, and a value-returning declaration sees that value.
import assert from "node:assert";
import { assert as testAssert, test } from "node:test";

declare module "node:test" {
  interface TestContextAssert {
    asyncEven(value: number): void;
    double(value: number): number;
  }
}

testAssert.register("asyncEven", async (value: number) => {
  await Promise.resolve();
  assert.strictEqual(value % 2, 0, `${value} is not even`);
});
testAssert.register("double", (value: number) => value * 2);

test("a void-typed async assertion is awaited", async (t) => {
  await t.assert.asyncEven(4);
});

test("a typed assertion returns its value", (t) => {
  assert.strictEqual(t.assert.double(21), 42);
});

test("a rejected void-typed assertion fails the test", async (t) => {
  await t.assert.asyncEven(3);
});
