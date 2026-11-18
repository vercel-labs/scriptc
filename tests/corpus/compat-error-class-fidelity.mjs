// What the standard error classes answer through values they are held as:
// AssertionError's stackStartFn trimming, the DOMException class a thrown
// value reports (its toStringTag, its own properties, and `code` on the
// prototype), and a SystemError's constructor.
import assert from "node:assert";
import os from "node:os";

let captured;
function innerFrame() {
  captured = new assert.AssertionError({ actual: 1, expected: 2, operator: "o", stackStartFn: innerFrame });
}
function outerFrame() {
  innerFrame();
}
outerFrame();
console.log("stackStartFn", captured.stack.includes("at innerFrame"), captured.stack.includes("at outerFrame"));

let plain;
function defaultMaker() {
  plain = new assert.AssertionError({ actual: 1, expected: 2, operator: "o" });
}
defaultMaker();
console.log("default frames", plain.stack.includes("at defaultMaker"));

function notOnStack() {}
let absent;
function maker() {
  absent = new assert.AssertionError({ actual: 1, expected: 2, operator: "o", stackStartFn: notOnStack });
}
maker();
console.log("absent stackStartFn", absent.stack.includes("at maker"), absent.stack.split("\n").length === 1);

let thrownDom;
try {
  throw new DOMException("message", "AbortError");
} catch (error) {
  thrownDom = error;
}
console.log("dom tag", Object.prototype.toString.call(thrownDom));
console.log(
  "dom own",
  Object.getOwnPropertyNames(thrownDom).filter((name) => name !== "stack").join(","),
  thrownDom.code,
  "code" in thrownDom,
  "stack" in thrownDom,
);

try {
  os.setPriority(999999, 0);
} catch (error) {
  console.log("system", error.constructor.name, error.name, error.code);
}
