// @normalize-pid
// assert.fail's deprecated multi-argument form: Node's AssertionError
// carries the actual and expected values, the operator (default "!=" for
// exactly two arguments, "fail" otherwise, or the given one), the message
// or the generated `${actual} ${operator} ${expected}`, and the
// generatedMessage flag; a message that is an Error is thrown itself, and
// the first call reports DEP0094 on stderr.
const assert = require("node:assert");
function show(name, f) {
  try {
    f();
    console.log(name, "pass");
  } catch (e) {
    console.log(name, JSON.stringify({
      name: e.name, code: e.code, operator: e.operator, generated: e.generatedMessage,
      message: e.message, actual: e.actual, expected: e.expected,
    }));
  }
}
show("two", () => assert.fail(1, 2));
show("twoStr", () => assert.fail("a", "b"));
show("three", () => assert.fail(1, 2, "m"));
show("four", () => assert.fail(1, 2, "m", "!="));
show("five", () => assert.fail(1, 2, "m", "==", assert.fail));
show("null", () => assert.fail(1, 2, null));
show("empty", () => assert.fail(1, 2, ""));
show("num", () => assert.fail(1, 2, 42));
show("obj", () => assert.fail({ b: 1, a: 2 }, { z: 1, y: [1, 2] }));
show("errMsg", () => assert.fail(1, 2, new Error("em")));
show("undefAll", () => assert.fail(undefined, null));
show("map", () => assert.fail(new Map([["k", 1]]), new Set([1])));
show("one", () => assert.fail("solo"));
try {
  assert.fail(1, 2, "plain");
} catch (e) {
  console.log("plain", e instanceof assert.AssertionError, e.operator, e.generatedMessage);
}
