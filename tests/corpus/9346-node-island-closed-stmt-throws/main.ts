// @exit: 1
// @requires-libnode
// An island-closed statement that throws: the error is thrown where the
// statement stands, after the statements before it ran, and uncaught it
// ends the program with Node's exit status.
import { alpha, registry } from "plug-kit";

console.log("before");
registry.register("alpha", alpha);
console.log("registered", registry.count());
registry.fail("no such plugin");
console.log("unreachable");
