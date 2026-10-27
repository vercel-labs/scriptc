// 'error', errorMonitor and the newListener/removeListener meta events on
// an emitter used both through its static type and through an untyped
// reference. Untyped emits of 'error' keep Node's contract: listeners of
// either kind receive the payload, and with none an Error throws itself
// while other payloads throw ERR_UNHANDLED_ERROR. Untyped meta listeners
// receive the event name and the listener function.
import { EventEmitter, errorMonitor } from "node:events";

const plain: any = new EventEmitter();
plain.on("newListener", (name: any, fn: any) => console.log("plain newListener", name, typeof fn));
plain.on("removeListener", (name: any, fn: any) => console.log("plain removeListener", name, fn.name));
function named(): void {}
plain.on("x", named);
plain.off("x", named);
plain.emit("newListener", "manual", named);

const e = new EventEmitter();
const d: any = e;
d.on("newListener", (name: any) => {
  console.log("newListener", name);
});
d.on("removeListener", (name: any) => {
  console.log("removeListener", name);
});
e.on("removeListener", (name: string) => console.log("typed removeListener", name));
const tap = (n: any): void => console.log("untyped v", n);
d.on("v", tap);
e.on("v", (n: number) => console.log("typed v", n));
e.emit("v", 1);
d.emit("v", 2);
d.off("v", tap);
e.emit("v", 3);
d.removeAllListeners("v");
console.log(d.listenerCount("v"));

d.removeAllListeners("newListener");
d.removeAllListeners("removeListener");
const monitor = (err: Error): void => console.log("monitor", err.message);
e.on(errorMonitor, monitor);
e.on("error", (err: Error) => console.log("typed error", err.message));
d.on("error", (err: any) => console.log("untyped error", err instanceof Error, err.message));
d.emit("error", new Error("boom"));
e.emit("error", new Error("bang"));
d.removeAllListeners("error");
try {
  d.emit("error", new Error("unhandled"));
} catch (err: any) {
  console.log("threw", err instanceof Error, err.message);
}
e.off(errorMonitor, monitor);
for (const payload of ["just text", 42, undefined, null, false]) {
  try {
    d.emit("error", payload);
  } catch (err: any) {
    console.log("threw", err.code, err.message);
  }
}
d.on("error", (x: any, more: any) => console.log("untyped got", x, more));
console.log(d.emit("error", 42, "more"), d.listenerCount("error"));
