// @requires-libnode
// @env: NODE_NO_WARNINGS=1
// Node is first loaded inside a native unhandledRejection listener, where
// island code registers listeners of its own, and the native listener then
// throws. What it threw is still an uncaught exception for the
// uncaughtException listeners, and the native listeners, which are older,
// stay ahead of the island's on the one emitter from then on.
import { callSync } from "@scriptc/node";

const log = (s) => console.log(s);

process.once("uncaughtException", (e, origin) => log(`native once: ${e.message} ${origin}`));
process.on("uncaughtException", (e, origin) => log(`native listener: ${e.message} ${origin}`));
process.on("warning", (w) => log(`native warning: ${w.message}`));
process.on("unhandledRejection", (r) => {
  log(`native rejection: ${r.message}`);
  if (r.message === "first") {
    callSync("./lib.cjs", "install");
    throw new Error("the rejection listener failed");
  }
});

const steps = [
  () => {
    Promise.reject(new Error("first"));
  },
  () => log(`counts ${callSync("./lib.cjs", "counts")}`),
  () => process.emitWarning("second", "CustomWarning"),
  () => {
    throw new Error("native, later");
  },
  () => {
    Promise.reject(new Error("native rejection"));
  },
  () => log("done"),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
