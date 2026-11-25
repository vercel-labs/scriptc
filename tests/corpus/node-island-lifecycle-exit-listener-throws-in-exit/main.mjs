// @exit: 3
// @requires-libnode
// An island 'exit' listener throws during process.exit(3) called by island
// code: the listeners after it do not run and the status stays 3.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log(`native exit listener first ${code}`));
lib.onExitThrow();
process.on("exit", (code) => console.log(`NOT REACHED native exit listener ${code}`));
console.log("exiting");
lib.exit(3);
