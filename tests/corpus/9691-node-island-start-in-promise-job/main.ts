// @requires-libnode
// Node starts inside a promise reaction. Rejections around the call that
// get their handler later in the same turn (in the same callback, in a
// tick, in a tick a microtask queues, in a tick island code queues) are
// handled: Node decides only when the tick queue and the microtasks are
// both drained. Ticks and microtasks queued before the call keep their
// place in the order.
import { kit } from "turn-kit";

async function fails(message: string): Promise<void> {
  throw new Error(message);
}
function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

console.log("start");
void Promise.resolve().then(() => {
  // Queued before Node starts: they move to Node's queues in order.
  process.nextTick(() => console.log("tick queued before the call"));
  queueMicrotask(() => console.log("microtask queued before the call"));
  const early = fails("rejected before the call");
  console.log("count", kit.count()); // the first island use: Node starts here
  early.catch((reason: unknown) => console.log("handled:", text(reason)));
  void (async () => {
    try {
      await fails("awaited in try");
    } catch (reason) {
      console.log("caught:", text(reason));
    }
  })();
  const byTick = fails("handled by a tick");
  process.nextTick(() => {
    byTick.catch((reason: unknown) => console.log("handled:", text(reason)));
  });
  const awaitedByTick = fails("awaited by a tick");
  process.nextTick(() => {
    void (async () => {
      try {
        await awaitedByTick;
      } catch (reason) {
        console.log("caught:", text(reason));
      }
    })();
  });
  const byMicrotaskTick = fails("handled by a microtask's tick");
  queueMicrotask(() => {
    process.nextTick(() => {
      byMicrotaskTick.catch((reason: unknown) => console.log("handled:", text(reason)));
    });
  });
  const byIslandTick = fails("handled by an island tick");
  kit.nextTick(() => {
    byIslandTick.catch((reason: unknown) => console.log("handled:", text(reason)));
  });
  kit.microtask(() => console.log("island microtask"));
  setImmediate(() => console.log("immediate"));
  console.log("end of the reaction");
});
console.log("end of the module");
