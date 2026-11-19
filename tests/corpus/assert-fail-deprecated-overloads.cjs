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
// A replacement process.emitWarning that throws keeps its error: the
// deprecation report is a call that can throw, not a silent one.
const origEmitWarning = process.emitWarning;
process.emitWarning = function () {
  throw new Error("warn-threw");
};
try {
  assert.fail(1, 2);
} catch (e) {
  console.log("warnReplace", e.name, e.message);
}
process.emitWarning = origEmitWarning;
// An operator that is undefined at run time takes Node's default.
const runtimeUndefinedOperator = undefined;
try {
  assert.fail(1, 2, "m", runtimeUndefinedOperator);
} catch (e) {
  console.log("opUndef", e.operator, e.message);
}
// An argument that cannot be recorded still evaluates.
function side() {
  console.log("side ran");
  return function inner() {};
}
try {
  assert.fail(side(), 2);
} catch (e) {
  console.log("side", JSON.stringify(e.message));
}
// Each argument is read once, in order: a later argument that reassigns a
// local must not change the value the error records.
let reassigned = { v: 1 };
try {
  assert.fail(reassigned, (reassigned = { v: 2 }, 2));
} catch (e) {
  console.log("snap", JSON.stringify(e.actual), JSON.stringify(e.message));
}
// A throwing ToString on the message propagates that error; on an operator it
// surfaces only when the generated message needs it.
const throwingText = { toString() { throw new Error("str-boom"); } };
try { assert.fail(1, 2, throwingText); } catch (e) { console.log("msgThrow", e.name, e.message); }
try { assert.fail(throwingText, 2); } catch (e) { console.log("genThrow", e.name, e.message); }
// A null operator stays null in the property and the generated message.
try { assert.fail(1, 2, "m", null); } catch (e) { console.log("nullOp", e.operator, JSON.stringify(e.message)); }
try { assert.fail(1, 2, null, null); } catch (e) { console.log("nullBoth", e.operator, JSON.stringify(e.message)); }
