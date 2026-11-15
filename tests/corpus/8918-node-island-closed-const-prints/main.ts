// @requires-libnode
// Island-closed initializers whose island function prints: the build's
// probe records the output, so the generated modules are not deferred and
// each evaluates where its constant is declared, between the program's own
// statements, as in Node.
import { Kit } from "shape-kit";

console.log("before");
const first = Kit.loud("first");
console.log("between");
const second = Kit.loud("second");
const third = Kit.list(second);
console.log("after", first.serial, second.serial, third.serial);
