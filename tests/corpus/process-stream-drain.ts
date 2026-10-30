// process.stdout/stderr backpressure probes under the synchronous stream
// model: every write reaches the descriptor before write() returns, so
// nothing is ever queued. writableLength is 0, writableNeedDrain is false,
// write() returns true, and 'drain' (emitted only after a write returned
// false) never fires: drain listeners register and stay silent, and a
// promise of the next drain never settles without holding the process.
import { once } from "node:events";

console.log("hwm", process.stdout.writableHighWaterMark, process.stderr.writableHighWaterMark);
console.log("needDrain", process.stdout.writableNeedDrain, process.stderr.writableNeedDrain);
console.log("length", process.stdout.writableLength, process.stderr.writableLength);

let drained = 0;
const onDrain = (): void => {
  drained++;
};
process.stdout.on("drain", onDrain);
process.stdout.once("drain", () => {
  drained++;
});
process.stderr.addListener("drain", onDrain);
process.stdout.off("drain", onDrain);
process.stderr.removeListener("drain", onDrain);

const ok = process.stdout.write("chunk\n");
console.log("write returned", ok);

// The flush idiom: wait for drain only when bytes are queued or the
// write asked for it.
async function flush(): Promise<void> {
  if (process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
  if (!process.stdout.write("again\n")) await once(process.stdout, "drain");
  console.log("flushed");
}
void flush();

// A drain that cannot come: the promise stays pending, and the process
// exits once the loop is empty.
void (async () => {
  await once(process.stderr, "drain");
  console.log("never");
})();

// A name expression typed "drain" still runs.
let picks = 0;
const drainName = (): "drain" => {
  picks++;
  return "drain";
};
void once(process.stdout, drainName());
void once(process.stderr, (picks++, "drain"));
console.log("picks", picks);

setTimeout(() => console.log("drained", drained), 5);
