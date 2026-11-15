/// <reference path="./globals.d.ts" />
// A bare reference to a global a `declare global` block declares resolves
// through the global object, as in Node: install.ts stores the program's
// values there first, so every read answers them. Both a `.d.ts` module's
// block and a `.ts` module's block behave the same.
import "./extra.ts";
import "./install.ts";

console.log(typeof document, typeof counter, typeof boots);
console.log(document.getElementById("x")!.id);
console.log(document.getElementById("y") === null ? "null" : "found");
console.log(counter + 1, counter / 2, boots * 3);
const el = document.getElementById("x");
console.log(el === null ? "gone" : "id:" + el.id);
