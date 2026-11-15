// @exit: 1
// @requires-libnode
// An island-closed initializer that throws: the error is thrown where the
// constant is declared, after the statements before it ran, and uncaught it
// ends the program with Node's exit status.
import { Kit } from "shape-kit";

console.log("before");
const fine = Kit.text();
console.log("declared", typeof fine);
const broken = Kit.fail("no such shape");
console.log("unreachable", broken.kind);
