// @exit: 7
// @requires-libnode
// process.exit() without an argument, called by native code, ends the
// process with the code island code assigned to process.exitCode.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.onExit();
lib.set(7);
setTimeout(() => log("NOT REACHED"), 50);
setTimeout(() => {
  log("native exits");
  process.exit();
}, 5);
