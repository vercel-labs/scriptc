// @exit: 3
// @requires-libnode
// A program that exits before it uses a deferred island package whose load
// reads unset variables: the module never evaluates, Node never starts,
// and the exit listeners and the exit status are the program's.
import { describe, VERSION } from "quiet-pkg";

process.on("exit", (code) => console.log("exit listener", code, typeof describe));
console.log("start", VERSION);
if (process.argv.length < 100) process.exit(3);
console.log(describe("never"));
