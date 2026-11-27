// @requires-libnode
// A native process.emit of a signal dispatches to an island listener with
// no arguments, as Node's emit does (a real delivery carries the signal's
// name and number).
import { callSync } from "@scriptc/node";

console.log("registered", callSync<boolean>("./probe.cjs", "register"));
console.log("emitted", process.emit("SIGTSTP"));
console.log("island args", callSync<number>("./probe.cjs", "seenArgs"));
