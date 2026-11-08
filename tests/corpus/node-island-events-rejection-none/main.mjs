// @exit: 1
// @requires-libnode
// A native promise that rejects with nobody handling it, and no listener
// for it on either side, ends the process with code 1 once Node is loaded,
// as an island rejection does: the exit listeners of both sides see the
// code, and nothing scheduled runs afterwards.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.install();
setTimeout(() => log("NOT REACHED"), 60);
setTimeout(() => {
  Promise.reject(new Error("native rejection"));
  log("rejected");
}, 5);
