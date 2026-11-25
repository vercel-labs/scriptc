// @exit: 1
// @requires-libnode
// An 'error' event with no listener on an island emitter, emitted by native
// code from a timer: an uncaught exception, exit 1.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
process.on("exit", (code) => console.log(`native exit listener ${code}`));
lib.onExit();
const bus = lib.emitter();
setTimeout(() => {
  console.log("emitting");
  bus.emit("error", new Error("unlistened"));
  console.log("NOT REACHED");
}, 5);
