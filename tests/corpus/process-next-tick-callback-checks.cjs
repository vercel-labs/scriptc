// process.nextTick validates its callback synchronously at the call:
// no argument and any non-function throw Node's ERR_INVALID_ARG_TYPE
// (the message names the received value's type), while a function is
// queued with its trailing arguments and runs before the timers.
"use strict";
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
const anyValue = /** @type {(value: any) => any} */ ((value) => value);
report("no callback", () => process.nextTick());
report("number callback", () => process.nextTick(anyValue(3)));
report("null callback", () => process.nextTick(anyValue(null)));
report("string callback", () => process.nextTick(anyValue("tick")));
report("object callback", () => process.nextTick(anyValue({})));
process.nextTick((a, b) => console.log("tick", a, b), "x", 2);
process.nextTick(() => console.log("plain tick"));
console.log("sync");
setTimeout(() => console.log("timer"), 0);
