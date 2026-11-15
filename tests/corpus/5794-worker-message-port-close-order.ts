// MessagePort close order: a port's own 'close' runs after the loop's
// poll phase, and the other end's close notice arrives in the next one,
// after its queued messages, while something keeps the loop alive.
//
// A timer keeps the loop alive, and the second notice clears it. It prints
// only when a notice never comes: where a timer's own line falls among the
// others depends on how long the program took to start (a timer that is
// already due runs before the loop's first poll, under Node as well).
import { MessageChannel } from "node:worker_threads";
const alive = setTimeout(() => console.log("a close notice never arrived"), 60000);
let notices = 2;
const noticed = (line: string): void => {
  console.log(line);
  if (--notices === 0) {
    clearTimeout(alive);
    console.log("both notices arrived");
  }
};
const d = new MessageChannel();
d.port2.on("close", () => noticed("d2 close (peer)"));
d.port1.on("close", () => console.log("d1 close (own)"));
d.port1.close();
const f = new MessageChannel();
f.port1.on("message", (m: unknown) => console.log("f got", m));
f.port2.postMessage("x");
f.port2.close();
f.port1.on("close", () => noticed("f1 close (peer, after messages)"));
