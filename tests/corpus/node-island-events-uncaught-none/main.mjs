// @exit: 1
// @requires-libnode
// An error native code lets escape after Node is loaded, with monitors on
// both sides and no uncaughtException listener on either: the monitors run,
// the process ends with code 1, and the exit listeners of both sides see
// that code, also as process.exitCode. Nothing scheduled runs afterwards.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.install();
process.on("uncaughtExceptionMonitor", (e, origin) => log(`native monitor: ${e.message} ${origin}`));
setTimeout(() => log("NOT REACHED"), 60);
setTimeout(() => {
  process.nextTick(() => log("NOT REACHED tick"));
  throw new Error("native failure");
}, 5);
