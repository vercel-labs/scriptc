// @requires-libnode
// An unhandledRejection listener across the start of Node: a rejection
// made before the call and one made after it, in a resumed asynchronous
// function, both reach the listener at the end of that turn, in order;
// a rejection awaited in try/catch never does. What the listener queues
// runs in the same turn.
import { kit } from "turn-kit";

async function fails(message: string): Promise<void> {
  throw new Error(message);
}
function text(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

process.on("unhandledRejection", (reason: unknown) => {
  console.log("unhandledRejection:", text(reason));
  void (async () => {
    await null;
    console.log("listener continued:", text(reason));
  })();
});

async function run(): Promise<void> {
  await Promise.resolve();
  void fails("rejected before the call");
  console.log("count", kit.count()); // the first island use: Node starts here
  void fails("rejected after the call");
  try {
    await fails("awaited in try");
  } catch (reason) {
    console.log("caught:", text(reason));
  }
  setImmediate(() => console.log("immediate"));
}

console.log("start");
await run();
console.log("end of the module");
