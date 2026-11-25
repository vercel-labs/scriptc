// @requires-libnode
// process.setUncaughtExceptionCaptureCallback, set by island code, takes
// the errors of both sides instead of the uncaughtException listeners; the
// monitors of both sides still run first, an unhandled rejection of either
// side is captured too, and once the callback is cleared the listeners
// handle errors again.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("uncaughtExceptionMonitor", (e, origin) => log(`native monitor: ${e.message} ${origin}`));
lib.monitor();
lib.capture();
log(`capturing ${lib.capturing()}`);

const steps = [
  () => {
    throw new Error("native 1");
  },
  () => lib.throwSoon("island 1"),
  () => {
    Promise.reject(new Error("native rejection"));
  },
  () => lib.rejectNow("island rejection"),
  () => {
    lib.release();
    log(`capturing ${lib.capturing()}`);
    process.on("uncaughtException", (e, origin) => log(`native listener: ${e.message} ${origin}`));
    lib.listen();
    throw new Error("native 2");
  },
  () => lib.throwSoon("island 2"),
  () => log("done"),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
