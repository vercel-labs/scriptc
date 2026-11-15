// @requires-libnode
// With Node already loaded, an 'exit' listener queues work on both sides:
// what Node runs of it (nothing from the timers and immediates).
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => {
  console.log(`exit listener ${code} ${lib.hello("from exit")}`);
  lib.schedule();
  setTimeout(() => console.log("NOT REACHED native timer"), 0);
  setImmediate(() => console.log("NOT REACHED native immediate"));
  process.nextTick(() => console.log("native tick queued during exit"));
  Promise.resolve().then(() => console.log("native microtask queued during exit"));
  console.log("exit listener done");
});
setTimeout(() => console.log("timer"), 5);
console.log("main end");
