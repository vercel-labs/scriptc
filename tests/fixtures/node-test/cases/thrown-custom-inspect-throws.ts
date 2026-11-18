// @exit: 1
import { inspect } from "node:util";
import { test } from "node:test";
const throwable = {
  [inspect.custom]() {
    throw new Error("inspect boom");
  },
};
test("custom inspector throws", () => { throw throwable; });
test("next test runs", () => {});
