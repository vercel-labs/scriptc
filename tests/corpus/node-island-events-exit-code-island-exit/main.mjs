// @exit: 4
// @requires-libnode
// process.exit() without an argument, called by island code, ends the
// process with the code native code assigned to process.exitCode.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.onExit();
process.exitCode = 4;
setTimeout(() => log("NOT REACHED"), 50);
setTimeout(() => {
  log("the island exits");
  lib.exit();
}, 5);
