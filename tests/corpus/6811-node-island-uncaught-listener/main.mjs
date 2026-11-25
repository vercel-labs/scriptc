// @requires-libnode
// The program's uncaughtException listener handles a throw from a native
// callback after Node loaded, and the loop goes on with the work of both
// sides. JavaScript: the typed declarations have no uncaughtException.
import { callSync } from "@scriptc/node";

process.on("uncaughtException", (error) => {
  console.log("caught", error.message);
});
// The island's timers (150 and 250 ms) are scheduled before these (10 and
// 50 ms), with gaps wide enough that a slow run keeps the delay order.
callSync("./island.cjs", "timers");
setTimeout(() => {
  console.log("native timer throws");
  throw new Error("native boom");
}, 10);
setTimeout(() => console.log("native timer after"), 50);
setImmediate(() => {
  queueMicrotask(() => {
    throw new Error("from a microtask");
  });
});
