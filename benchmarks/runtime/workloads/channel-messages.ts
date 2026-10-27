// MessageChannel messages within one thread: the program posts the given
// number of messages, half of them numbers and half small objects, before
// the port delivers any, so all of them are queued at once. Argument: the
// number of messages.
import { MessageChannel } from "node:worker_threads";

const count = Number(process.argv[2] ?? "200000");
const { port1, port2 } = new MessageChannel();
let received = 0;
let sum = 0;
port1.on("message", (value: number | { id: number; name: string }) => {
  sum += typeof value === "number" ? value : value.id + value.name.length;
  if (++received === count) {
    console.log(`${count} messages, sum ${sum}`);
    port1.close();
  }
});
for (let i = 0; i < count; i++) {
  if (i % 2 === 0) port2.postMessage(i);
  else port2.postMessage({ id: i, name: "item" });
}
