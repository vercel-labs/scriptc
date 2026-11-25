// @exit: 6
// @requires-libnode
// process.exit(code) called by island code replaces the code native code
// assigned to process.exitCode, and the exit listeners of both sides read
// the new code from process.exitCode.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.onExit();
process.exitCode = 2;
setTimeout(() => log("NOT REACHED"), 50);
setTimeout(() => {
  log(`before: island ${lib.get()}`);
  lib.exit(6);
}, 5);
