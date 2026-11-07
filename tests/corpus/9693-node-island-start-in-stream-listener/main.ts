// @requires-libnode
// Node starts inside a native event callback, a file stream's 'data'
// listener: the callback's ticks and promise jobs run before anything
// else the loop has, and its rejections are decided after them.
import { createReadStream, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kit } from "turn-kit";

async function fails(message: string): Promise<void> {
  throw new Error(message);
}
function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

console.log("start");
const file = join(tmpdir(), `scriptc-9693-${process.pid}.txt`);
writeFileSync(file, "one chunk");
createReadStream(file, "utf8")
  .on("data", (chunk) => {
    console.log("data", chunk);
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
    console.log("end of the listener");
  })
  .on("close", () => rmSync(file, { force: true }));
console.log("end of the module");
