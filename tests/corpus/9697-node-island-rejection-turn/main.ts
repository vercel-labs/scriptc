// @requires-libnode
// With Node's loop running the program (Node started in the module's own
// statements), a rejection whose handler a later tick of the same turn
// attaches is handled, in the module, in a timer and in an immediate: Node
// decides when the tick queue is empty too, not at V8's first microtask
// checkpoint. The tick may be one only island code queued, at the end of a
// chain of its own ticks and microtasks.
import { kit } from "turn-kit";

async function fails(message: string): Promise<void> {
  throw new Error(message);
}
function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

console.log("count", kit.count()); // the first island use: Node starts here
function turn(label: string): void {
  const byTick = fails(`${label}: handled by a tick`);
  process.nextTick(() => {
    byTick.catch((reason: unknown) => console.log("handled:", text(reason)));
  });
  const byMicrotaskTick = fails(`${label}: handled by a microtask's tick`);
  queueMicrotask(() => {
    process.nextTick(() => {
      byMicrotaskTick.catch((reason: unknown) => console.log("handled:", text(reason)));
    });
  });
  const byIslandTick = fails(`${label}: handled by an island tick`);
  queueMicrotask(() => {
    kit.nextTick(() => {
      byIslandTick.catch((reason: unknown) => console.log("handled:", text(reason)));
    });
  });
  const byIslandChain = fails(`${label}: handled at the end of an island chain`);
  kit.tickChain(() => {
    byIslandChain.catch((reason: unknown) => console.log("handled:", text(reason)));
  });
}
turn("module");
setTimeout(() => {
  turn("timer");
  setImmediate(() => turn("immediate"));
}, 1);
console.log("end of the module");
