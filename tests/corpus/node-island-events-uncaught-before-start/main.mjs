// @requires-libnode
// @env: NODE_NO_WARNINGS=1
// Listeners native code installs before Node is loaded handle native events
// by themselves, and move onto Node's process emitter when Node loads, in
// their order and ahead of the listeners island code adds then: a once
// listener already used does not come back, and events of either side reach
// both sides from there on.
import { callSync } from "@scriptc/node";

const log = (s) => console.log(s);

process.on("uncaughtExceptionMonitor", (e, origin) => log(`native monitor: ${e.message} ${origin}`));
process.once("uncaughtException", (e) => log(`native once: ${e.message}`));
process.on("uncaughtException", (e, origin) => log(`native listener: ${e.message} ${origin}`));
process.on("unhandledRejection", (r) => log(`native rejection: ${r.message}`));
process.on("warning", (w) => log(`native warning: ${w.name}: ${w.message}`));

const steps = [
  () => {
    throw new Error("before Node");
  },
  () => {
    Promise.reject(new Error("rejected before Node"));
  },
  () => {
    callSync("./lib.cjs", "install");
    log(`counts ${callSync("./lib.cjs", "counts")}`);
  },
  () => {
    throw new Error("native, after");
  },
  () => callSync("./lib.cjs", "throwSoon", "island, after"),
  () => {
    Promise.reject(new Error("native rejection, after"));
  },
  () => callSync("./lib.cjs", "rejectNow", "island rejection, after"),
  () => process.emitWarning("native warning, after", "CustomWarning"),
  () => callSync("./lib.cjs", "warn", "island warning, after"),
  () => log("done"),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
