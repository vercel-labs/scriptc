import assert from "node:assert";

function report(label, action) {
  try { action(); console.log(label, "pass"); }
  catch (error) { console.log(label, error.name, error.message); }
}

const original = new RangeError("boom");
report("error-class", () => assert.doesNotThrow(() => { throw original; }, Error));
report("subclass-match", () => assert.doesNotThrow(() => { throw original; }, RangeError));
report("subclass-miss", () => assert.doesNotThrow(() => { throw original; }, TypeError));
const receivers = [];
function validator(actual) {
  console.log("validator", actual === original, Object.getPrototypeOf(this) === Object.prototype, Object.keys(this).length);
  receivers.push(this);
  return false;
}
try { assert.doesNotThrow(() => { throw original; }, validator); }
catch (error) { console.log("original", error === original); }
try { assert.doesNotThrow(() => { throw original; }, validator); } catch {}
console.log("fresh", receivers[0] !== receivers[1]);

const sentinel = { tag: "sentinel" };
const getterFailure = { get message() { throw sentinel; } };
try { assert.doesNotThrow(() => { throw getterFailure; }); }
catch (error) { console.log("getter-identity", error === sentinel); }
const reason = { message: { toString() { return "custom message"; } } };
report("message-coercion", () => assert.doesNotThrow(() => { throw reason; }));
const symbolMessage = { message: Symbol("message") };
report("symbol-message", () => assert.doesNotThrow(() => { throw symbolMessage; }));
const exoticMessage = { message: { [Symbol.toPrimitive](hint) { return "message " + hint; } } };
report("exotic-message", () => assert.doesNotThrow(() => { throw exoticMessage; }));

const ordinary = { toString() { return "custom reason"; }, message: "ordinary" };
report("ordinary", () => assert.doesNotThrow(() => { throw ordinary; }, /^custom reason$/));
const exotic = { [Symbol.toPrimitive](hint) { console.log("hint", hint); return "exotic reason"; } };
report("exotic", () => assert.doesNotThrow(() => { throw exotic; }, /^exotic reason$/));
try { assert.doesNotThrow(() => { throw exotic; }, Error); }
catch (error) { console.log("error-validator", error === exotic); }
const changed = new Error("before");
changed.name = "Changed";
changed.message = "after";
report("changed", () => assert.doesNotThrow(() => { throw changed; }, /^Changed: after$/));
const custom = new Error("custom");
custom.toString = () => "formatted error";
report("custom-error", () => assert.doesNotThrow(() => { throw custom; }, /^formatted error$/));
const conversionFailure = { toString() { throw sentinel; } };
try { assert.doesNotThrow(() => { throw conversionFailure; }, /anything/); }
catch (error) { console.log("conversion-identity", error === sentinel); }
const formatterGetter = {};
Object.defineProperty(formatterGetter, "toString", { get() { throw sentinel; } });
const stateful = /anything/g;
stateful.lastIndex = 3;
try { assert.doesNotThrow(() => { throw formatterGetter; }, stateful); }
catch (error) { console.log("formatter-getter", error === sentinel, stateful.lastIndex); }
