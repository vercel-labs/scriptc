// @exit: 5
// @requires-libnode
// An island timer calls process.exit while the program's own timers keep
// the loop busy: the code and the exit listeners are the program's.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => console.log("native exit listener", code));
callSync("./process.cjs", "exitLater", 5, 20);
let ticks = 0;
const interval = setInterval(() => {
  ticks++;
}, 2);
setTimeout(() => {
  clearInterval(interval);
  console.log("never");
}, 200);
setTimeout(() => console.log("native timer before", ticks > 0), 10);
