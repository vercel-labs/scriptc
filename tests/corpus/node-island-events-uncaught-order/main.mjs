// @requires-libnode
// uncaughtException listeners of native code and of island code are one
// list on one emitter: they run in registration order for a throw from
// either side, the monitors first, and once, off, prependListener and
// listenerCount act on that one list.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const log = (s) => console.log(s);

const first = (e, origin) => log(`native first: ${e.message} ${origin}`);
const third = (e) => log(`native third: ${e.message}`);
const once = (e) => log(`native once: ${e.message}`);
const front = (e) => log(`native front: ${e.message}`);
const monitor = (e, origin) => log(`native monitor: ${e.message} ${origin}`);

process.on("uncaughtException", first);
lib.on("uncaughtException", "second");
process.on("uncaughtException", third);
lib.on("uncaughtExceptionMonitor", "monitor");
process.on("uncaughtExceptionMonitor", monitor);
log(`counts ${lib.count("uncaughtException")} ${lib.count("uncaughtExceptionMonitor")}`);

const steps = [
  () => lib.throwSoon("island 1"),
  () => {
    throw new Error("native 1");
  },
  () => {
    process.once("uncaughtException", once);
    lib.once("uncaughtException", "once");
    process.prependListener("uncaughtException", front);
    lib.prepend("uncaughtException", "front");
    process.off("uncaughtException", first);
    lib.off("uncaughtException", "second");
    process.removeListener("uncaughtExceptionMonitor", monitor);
    log(`counts ${lib.count("uncaughtException")} ${lib.count("uncaughtExceptionMonitor")}`);
    throw new Error("native 2");
  },
  () => {
    log(`counts ${lib.count("uncaughtException")} ${lib.count("uncaughtExceptionMonitor")}`);
    lib.throwSoon("island 2");
  },
  () => {
    // A listener the island removes by the function it was given.
    lib.offValue("uncaughtException", third);
    log(`counts ${lib.count("uncaughtException")} ${lib.listed("uncaughtException")}`);
    throw new Error("native 3");
  },
  () => log("done"),
];
setTimeout(function run() {
  if (steps.length > 1) setTimeout(run, 25);
  steps.shift()();
}, 5);
