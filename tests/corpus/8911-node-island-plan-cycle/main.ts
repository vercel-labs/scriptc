// @requires-libnode
// Import cycles inside island packages, between modules that name each
// other by relative paths: an ES module reads a binding of the module that
// is still waiting for it (a dead-zone ReferenceError with the binding's
// own name), and a CommonJS module sees the half-filled exports of the one
// that required it.
import { done, late as lateKeys, name, sawPartial } from "cyclecjs";
import { early, late, orderText, value } from "cyclepkg";

console.log(early);
console.log(late(), value, orderText());
console.log(name, sawPartial, done, lateKeys());
