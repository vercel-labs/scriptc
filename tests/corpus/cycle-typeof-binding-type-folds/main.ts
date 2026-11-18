// `typeof` of import-cycle bindings whose answer the compiler can take
// from the binding's type: a cast or non-null operand, and a union whose
// arms all give the same answer (as a value and in a `typeof x !==
// "undefined"` test). Until the declaration ran, Node's typeof still
// throws the binding's ReferenceError, so the read cannot be dropped.
import { value, choice, when } from "./dom.ts";
import { probes } from "./lib.ts";

console.log("main: " + probes());
console.log(typeof value, typeof choice, typeof when);
