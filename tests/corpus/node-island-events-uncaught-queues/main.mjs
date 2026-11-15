// @requires-libnode
// What runs after an uncaughtException listener handled an error a native
// timer, immediate or tick let escape, with Node loaded: the next timer of
// the same list runs before the ticks and promise jobs the listener queued,
// the rest of the tick queue waits for the next callback, and the remaining
// immediates still run, as after a handled error in Node's own callbacks.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

let n = 0;
process.on("uncaughtException", (e) => {
  const id = ++n;
  log(`handled ${e.message}`);
  process.nextTick(() => log(`tick queued by listener ${id}`));
  Promise.resolve().then(() => log(`job queued by listener ${id}`));
});
lib.listen();

setTimeout(() => {
  throw new Error("timer");
}, 1);
setTimeout(() => log("timer of the same list"), 1);
// Both timers are due when the loop first looks at their list.
for (const end = Date.now() + 10; Date.now() < end; );
setTimeout(() => {
  setImmediate(() => {
    throw new Error("immediate");
  });
  setImmediate(() => log("second immediate"));
}, 20);
setTimeout(() => {
  process.nextTick(() => {
    throw new Error("tick");
  });
  process.nextTick(() => log("second tick"));
  Promise.resolve().then(() => log("job after the ticks"));
}, 40);
setTimeout(() => {
  queueMicrotask(() => {
    throw new Error("microtask");
  });
  queueMicrotask(() => log("second microtask"));
}, 60);
setTimeout(() => log("done"), 80);
