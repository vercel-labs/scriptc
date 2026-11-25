/// <reference path="./globals.d.ts" />
// A `typeof` comparison on a declared global answers before the program
// installs its property: `typeof document === "undefined"` is true and never
// throws, as in Node, where that guard is the ordinary feature-test idiom.
// After install.ts stores the values, the same guards answer for them.
import { before } from "./probe.ts";
import "./install.ts";

console.log(before.join(","));
console.log(typeof document, typeof counter);
console.log(typeof document === "undefined", typeof document !== "undefined");
console.log(typeof counter === "number", typeof counter === "undefined");
if (typeof document === "undefined") console.log("late guard: absent");
else console.log("late guard: present");
console.log(document.getElementById("x")!.id);
console.log(counter + 1);
