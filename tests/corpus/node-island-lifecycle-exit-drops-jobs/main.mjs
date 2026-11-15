// @exit: 5
// @requires-libnode
// process.exit called by island code ends the program there: promise jobs
// and ticks native code queued before the call do not run.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log(`exit listener ${code}`));
Promise.resolve().then(() => console.log("NOT REACHED microtask"));
process.nextTick(() => console.log("NOT REACHED tick"));
(async () => {
  await null;
  console.log("NOT REACHED async continuation");
})();
console.log("exiting");
lib.exit(5);
