// util.setTraceSigInt in the dynamic path: every value is accepted, none
// is coerced (the argument's toString/valueOf getters never run), the call
// answers undefined with no arguments at all, and every argument expression
// is evaluated (surplus arguments too).
"use strict";
const util = require("node:util");

const log = [];
const probe = {
  get toString() {
    log.push("toString");
    return () => "x";
  },
  get valueOf() {
    log.push("valueOf");
    return () => 1;
  },
};
const result = util.setTraceSigInt(probe);
console.log("result", result, "coerced", log.length);

let count = 0;
function tick() {
  count++;
  return true;
}
const extra = util.setTraceSigInt(tick(), tick(), tick());
console.log("extra", extra, count);

const none = util.setTraceSigInt();
console.log("none", none);
