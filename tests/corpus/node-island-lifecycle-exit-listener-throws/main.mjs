// @exit: 1
// @requires-libnode
// An island 'exit' listener throws at a natural end: the error is fatal,
// the listeners after it do not run, and the process exits with status 1.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log(`native exit listener first ${code}`));
lib.onExitThrow();
process.on("exit", (code) => console.log(`NOT REACHED native exit listener ${code}`));
lib.onExit("NOT REACHED");
console.log("main end");
