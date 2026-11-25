// @exit: 3
// @requires-libnode
// process.exit(code) with an argument replaces the code the other side
// assigned to process.exitCode: island code set 7, native code exits with 3,
// and the exit listeners of both sides read 3 from process.exitCode.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.onExit();
lib.set(7);
setTimeout(() => log("NOT REACHED"), 50);
setTimeout(() => {
  log(`before: native ${process.exitCode}`);
  process.exit(3);
}, 5);
