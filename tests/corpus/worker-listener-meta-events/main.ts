// A Worker extends EventEmitter: it seeds Node's internal
// 'newListener'/'removeListener' listeners, fires the meta events on
// add/remove, keeps duplicate registrations, and emit delivers every
// argument with EventEmitter's unhandled-'error' throw. A MessagePort is a
// NodeEventTarget: same seeded listeners, no meta events, one entry per
// listener, and raw one-argument emit. The same split decides the module
// helpers: events.getMaxListeners reads a Worker's configured limit, while
// a port answers the process default there and its own limit only through
// its method.
import { getMaxListeners } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";

const worker = new Worker(new URL("./worker.ts", import.meta.url));
console.log(
  "worker seeded",
  worker.listenerCount("newListener"),
  worker.listenerCount("removeListener"),
  worker.eventNames().map(String).sort().join(","),
);

const seen: string[] = [];
const onNew = (name: string | symbol) => seen.push(`new:${String(name)}`);
const onRemove = (name: string | symbol) => seen.push(`remove:${String(name)}`);
worker.on("newListener", onNew);
worker.on("removeListener", onRemove);
console.log("after meta listeners", seen.join(","));

const emitted: number[] = [];
const message = (...args: unknown[]) => emitted.push(args.length);
worker.on("message", message);
worker.on("message", message);
console.log("worker duplicate count", worker.listenerCount("message"), "meta", seen.join(","));
worker.emit("message", 1, 2, 3);
worker.off("message", message);
console.log("worker after one off", worker.listenerCount("message"));
worker.off("message", message);
console.log("worker after two offs", worker.listenerCount("message"));
console.log("worker emitted arg counts", emitted.join(","));

let threw = "no";
try {
  worker.emit("error", new Error("boom"));
} catch (err) {
  threw = (err as Error).message;
}
console.log("worker emit error", threw);

console.log("worker eventNames", worker.eventNames().map(String).sort().join(","));

const channel = new MessageChannel();
console.log(
  "port seeded",
  channel.port1.listenerCount("newListener"),
  channel.port1.listenerCount("removeListener"),
  channel.port1.eventNames().map(String).sort().join(","),
);
const portSeen: string[] = [];
channel.port1.on("newListener", (name: string | symbol) => portSeen.push(`new:${String(name)}`));
channel.port1.on("removeListener", (name: string | symbol) => portSeen.push(`remove:${String(name)}`));
const portMessage = () => {};
channel.port1.on("message", portMessage);
channel.port1.on("message", portMessage);
console.log("port duplicate count", channel.port1.listenerCount("message"), "meta", portSeen.join(","));
channel.port1.off("message", portMessage);
console.log("port after off", channel.port1.listenerCount("message"));
const portEmit = channel.port1.emit("message", 1, 2);
console.log("port emit result", portEmit, "meta", portSeen.join(","));
let portThrew = "no";
try {
  channel.port1.emit("error", new Error("port boom"));
} catch (err) {
  portThrew = (err as Error).message;
}
console.log("port emit error", portThrew);

console.log("worker max", getMaxListeners(worker), worker.getMaxListeners());
worker.setMaxListeners(20);
console.log("worker max after set", getMaxListeners(worker), worker.getMaxListeners());
console.log("port max", getMaxListeners(channel.port1), channel.port1.getMaxListeners());
channel.port1.setMaxListeners(20);
console.log("port max after set", getMaxListeners(channel.port1), channel.port1.getMaxListeners());

worker.off("removeListener", onRemove);
worker.off("newListener", onNew);
console.log("worker meta after removal", seen.join(","));
channel.port1.close();
channel.port2.close();
await worker.terminate();
console.log("terminated");
