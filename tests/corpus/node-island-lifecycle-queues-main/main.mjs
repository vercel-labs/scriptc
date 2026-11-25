// @requires-libnode
// Ticks, microtasks, timers and immediates queued alternately by native and
// island code from the main body: one set of queues, Node's order.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

function nativeAll(tag) {
  setImmediate(() => log(`${tag} immediate`));
  process.nextTick(() => log(`${tag} tick`));
  queueMicrotask(() => log(`${tag} microtask`));
  Promise.resolve().then(() => log(`${tag} then`));
}

nativeAll("n1");
lib.queueAll("i1");
nativeAll("n2");
lib.queueAll("i2");
// Native callbacks scheduled through the island's queues.
lib.tick(() => log("n-cb island tick"));
lib.micro(() => log("n-cb island microtask"));
lib.immediate(() => log("n-cb island immediate"));
log("main end");
