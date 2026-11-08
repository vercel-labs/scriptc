// @exit: 1
// @requires-libnode
// An error island code lets escape, with monitors on both sides and no
// uncaughtException listener on either: the monitors run in registration
// order, the process ends with code 1, and the exit listeners of both sides
// see that code, also as process.exitCode.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("uncaughtExceptionMonitor", (e, origin) => log(`native monitor: ${e.message} ${origin}`));
process.on("exit", (code) => log(`native exit ${code} ${process.exitCode}`));
lib.install();
setTimeout(() => log("NOT REACHED"), 60);
lib.throwSoon("island failure");
