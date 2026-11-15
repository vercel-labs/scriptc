// `typeof` of a binding in an import cycle: lib.js imports `document`
// from dom.ts, which imports lib.js back and declares the binding after
// running code that reaches lib.js. Node's typeof throws the binding's
// ReferenceError until the declaration ran, both as a value and in a
// `typeof x !== "undefined"` guard, and answers "object" afterwards.
import { document } from "./dom.ts";
import { label } from "./lib.js";

console.log(label());
console.log(document.describe());
console.log(typeof document === "object", document.title);
