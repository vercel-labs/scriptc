// @exit: 4
// @requires-libnode
// process.exit in island code, called from a timer while more timers and
// an interval are pending: the program ends at once with the code, after
// the 'exit' listeners of both sides ran in registration order.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => console.log("native exit listener", code));
callSync("./process.cjs", "onExit", "a");
let intervals = 0;
const interval = setInterval(() => {
  intervals++;
}, 1);
setTimeout(() => {
  console.log("timer", intervals > 0);
  callSync("./process.cjs", "exitNow", 4);
  console.log("not reached");
}, 10);
setTimeout(() => {
  clearInterval(interval);
  console.log("never");
}, 50);
