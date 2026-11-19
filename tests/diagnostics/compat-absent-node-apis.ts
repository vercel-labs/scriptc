// Node APIs scriptc does not implement, one use each: every statement
// below is refused by name. The compatibility ledger cites this program
// for marking the rows a verified absence instead of an unverified
// registry gap.
import { EventEmitterAsyncResource } from "node:events";
import { findPackageJSON, register } from "node:module";

// timers: closing a Timeout.
const timer = setTimeout(() => {}, 1);
timer.close();


// module: loader hooks and package lookup.
register("./hooks.mjs", import.meta.url);
console.log(findPackageJSON("..", import.meta.url));

// events: the EventEmitter that carries an AsyncResource.
const emitter = new EventEmitterAsyncResource({ name: "Probe" });
emitter.emit("x");

// process: the worker events and the execve entry point.
process.on("worker", () => {});
process.on("workerMessage", () => {});
process.execve("/bin/true", []);
