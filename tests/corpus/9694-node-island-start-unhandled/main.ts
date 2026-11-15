// @exit: 1
// @requires-libnode
// Node starts inside a promise job that leaves a rejection nobody handles:
// it is still reported, after the ticks and promise jobs of the turn and
// before any later timer, and the program exits 1.
import { kit } from "turn-kit";

async function fails(message: string): Promise<void> {
  throw new Error(message);
}
function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

console.log("start");
queueMicrotask(() => {
  console.log("count", kit.count()); // the first island use: Node starts here
  process.nextTick(() => console.log("tick before the report"));
  queueMicrotask(() => console.log("microtask before the report"));
  kit.nextTick(() => console.log("island tick before the report"));
  setTimeout(() => console.log("timer after the report: must not print"), 30);
  void fails("nobody handles this");
});
console.log("end of the module");
