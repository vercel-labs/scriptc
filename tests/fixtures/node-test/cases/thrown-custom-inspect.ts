// @exit: 1
// A thrown value with a custom inspector: the failing section renders it
// through util.inspect, which runs the value's own inspector. The message is
// rendered when the result settles, not when the exit-time summary prints,
// so the inspector never runs after the program's values are released.
import { inspect } from "node:util";
import { test } from "node:test";
const prefix = "custom";
const throwable = {
  [inspect.custom]() {
    return `${prefix}-value`;
  },
};
test("custom inspected", () => { throw throwable; });
