// @requires-libnode
// With no unhandledRejection listener on either side, an unhandled
// rejection of either side is an uncaught exception with the origin
// "unhandledRejection": the monitors and uncaughtException listeners of both
// sides receive it, in registration order, and the program goes on.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

process.on("uncaughtException", (e, origin) => log(`native listener: ${e.message} ${origin}`));
lib.listen();
process.on("uncaughtExceptionMonitor", (e, origin) => log(`native monitor: ${e.message} ${origin}`));

const steps = [
  () => {
    Promise.reject(new Error("native rejection"));
  },
  () => lib.rejectNow("island rejection"),
  () => {
    // A reason that is not an error reaches the listeners as Node's error
    // for it.
    Promise.reject("just text");
  },
  () => log("done"),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
