// @exit: 1
// @requires-libnode
// Node starts inside a tick that then throws. The throw is an uncaught
// exception: the program ends there, and nothing the tick queued runs,
// neither what it queued after Node started nor the timer.
import { kit } from "turn-kit";

console.log("start");
process.nextTick(() => {
  console.log("count", kit.count()); // the first island use: Node starts here
  process.nextTick(() => console.log("tick queued before the throw: must not print"));
  queueMicrotask(() => console.log("microtask queued before the throw: must not print"));
  setTimeout(() => console.log("timer: must not print"), 30);
  throw new Error("thrown after the call");
});
console.log("end of the module");
