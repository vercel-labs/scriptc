// The default import of node:process is the process object: read as a
// value, directly or through a second binding, it is the global's object.
import process from "node:process";

const anyProcess = process;

function methods(any, sub) {
  return { any: typeof any.pid, sub, same: any === process };
}

function usable(p) {
  return p && typeof p === "object" && typeof p.on === "function" && typeof p.pid === "number";
}

console.log(usable(process), usable(anyProcess), typeof anyProcess, anyProcess === process);
console.log(JSON.stringify(methods(anyProcess, false)), JSON.stringify(methods(process, true)));
console.log(anyProcess === globalThis.process, process === globalThis.process);
console.log(typeof anyProcess.platform, anyProcess.platform === process.platform, anyProcess.argv.length > 0);

const held = { ...{ channel: anyProcess.channel }, anyProcess, isSubprocess: true };
console.log(held.anyProcess === process, held.channel, held.isSubprocess, Object.keys(held).join(","));
if (process.defaultApp) console.log("default app");
console.log(process.channel !== undefined, typeof process.nextTick);
