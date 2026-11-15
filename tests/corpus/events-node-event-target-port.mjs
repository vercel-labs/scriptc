// MessagePort is a NodeEventTarget: an emitter behind a handle whose
// emit() is the target's raw dispatch. It carries one argument (extra
// arguments are ignored), throws Node's ERR_INVALID_ARG_TYPE for a non-string
// name, does not throw on an unheard 'error' (it answers false), leaves the
// seeded 'newListener'/'removeListener' listeners unfired on add and remove,
// and answers a target's own listener count, names and limits — while the
// module-level getMaxListeners reads the EventEmitter slot targets never set,
// so it reports the process default even after setMaxListeners(n). A Worker
// is not a NodeEventTarget: it extends EventEmitter, and
// worker-listener-meta-events pins that difference.
import { MessageChannel } from "node:worker_threads";
import { getEventListeners, listenerCount, getMaxListeners } from "node:events";

const { port1, port2 } = new MessageChannel();
console.log("seeded meta", port1.listenerCount("newListener"), listenerCount(port1, "removeListener"));
console.log("seeded fn", typeof getEventListeners(port1, "removeListener")[0]);
console.log("default max", getMaxListeners(port1), port1.getMaxListeners());
port1.setMaxListeners(3);
console.log("after set", getMaxListeners(port1), port1.getMaxListeners());
console.log("emit unheard", port1.emit("nothing", 1));

port1.on("tick", (a, b) => console.log("tick", a, b));
console.log("emit tick", port1.emit("tick", 1, "two"));
port1.emit("tick");
console.log("tick count", port1.listenerCount("tick"));

console.log("emit error", port1.emit("error", new Error("boom")));
port1.on("error", (err) => console.log("error listener", err.message));
console.log("emit error handled", port1.emit("error", new Error("boom2")));

port1.on("newListener", (name) => console.log("newListener fired", name));
port1.on("added", () => {});
port1.emit("newListener", "manual");

console.log("names", port1.eventNames());

try {
  port1.setMaxListeners(-1);
} catch (err) {
  console.log("bad max", err.name, err.code);
}
try {
  port1.emit(1);
} catch (err) {
  console.log("bad name", err.name, err.code, err.message);
}

port1.off("tick", () => {});
port1.once("only", (v) => console.log("once", v));
port1.emit("only", 1);
port1.emit("only", 2);
port1.removeAllListeners("tick");
console.log("names after", port1.eventNames().includes("tick"), port1.listenerCount("tick"));

// The type's listeners are a Set of the original functions: emit always
// hands a listener one value, and a listener already registered makes a
// second on() or once() of the same function a no-op.
port1.on("rest", (...args) => console.log("rest", args.length, args));
port1.emit("rest");
port1.emit("rest", 1, 2);
const dup = (v) => console.log("dup", v);
port1.on("dup", dup);
port1.on("dup", dup);
port1.once("dup", dup);
console.log("dup count", port1.listenerCount("dup"));
port1.emit("dup", 1);
console.log("dup after", port1.listenerCount("dup"));
const twice = (v) => console.log("twice", v);
port1.once("twice", twice);
port1.once("twice", twice);
console.log("twice count", port1.listenerCount("twice"));
port1.emit("twice", 1);
console.log("twice after", port1.listenerCount("twice"));

port1.close();
port2.close();
