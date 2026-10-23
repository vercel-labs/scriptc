// @requires-libnode
// The program's uncaughtException listener handles a throw from a native
// callback after Node loaded, and the loop goes on with the work of both
// sides. JavaScript: the typed declarations have no uncaughtException.
import { callSync } from "@scriptc/node";

process.on("uncaughtException", (error) => {
  console.log("caught", error.message);
});
callSync("./island.cjs", "timers");
setTimeout(() => {
  console.log("native timer throws");
  throw new Error("native boom");
}, 5);
setTimeout(() => console.log("native timer after"), 10);
setImmediate(() => {
  queueMicrotask(() => {
    throw new Error("from a microtask");
  });
});
