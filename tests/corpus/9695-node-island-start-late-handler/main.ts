// @exit: 1
// @requires-libnode
// Node starts inside a tick that rejects a promise whose handler is only
// attached one turn later, from an immediate: too late. Node reports the
// rejection at the end of the tick's turn and the immediate never runs.
import { kit } from "turn-kit";

async function fails(message: string): Promise<void> {
  throw new Error(message);
}
function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

console.log("start");
process.nextTick(() => {
  console.log("count", kit.count()); // the first island use: Node starts here
  const late = fails("handled too late");
  setImmediate(() => {
    late.catch(() => console.log("late handler: must not print"));
  });
  queueMicrotask(() => console.log("microtask before the report"));
});
console.log("end of the module");
