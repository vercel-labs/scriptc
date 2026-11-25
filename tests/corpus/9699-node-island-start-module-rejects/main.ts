// @exit: 1
// @requires-libnode
// Node starts inside a resumed asynchronous function that then throws, and
// the main module awaits that function, so the module's evaluation
// rejects. Node's loader ends the program at that promise job, before the
// ticks of the turn, although an ordinary unhandled rejection waits for
// them.
import { kit } from "turn-kit";

async function run(): Promise<void> {
  await Promise.resolve();
  console.log("count", kit.count()); // the first island use: Node starts here
  process.nextTick(() => console.log("tick queued before the throw: must not print"));
  setTimeout(() => console.log("timer: must not print"), 30);
  throw new Error("thrown after the call");
}

console.log("start");
await run();
console.log("end of the module: must not print");
