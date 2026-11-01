// @normalize-pid
// Symbol event names: the emitter keys a symbol by IDENTITY, not by its
// description — two Symbol("s") names are separate events — and
// Symbol.for() names join across call sites. eventNames() lists symbols
// after the string names, in Node's _events key order (integer-index
// strings by value, then other strings in insertion order, then symbols in
// insertion order); listeners()/rawListeners()/removeListener/
// removeAllListeners/listenerCount accept them, and a leak warning renders
// the name as Symbol(description).
import { EventEmitter, errorMonitor } from "node:events";

process.on("warning", (w) => console.log("warning:", w.name, "|", w.message));

const e = new EventEmitter();
const a = Symbol("a");
const a2 = Symbol("a");
const shared = Symbol.for("shared");

function onA(v: number): void {
  console.log("a", v);
}
function onA2(): void {
  console.log("a2");
}
function onShared(): void {
  console.log("shared");
}

e.on(a, onA);
e.on(a2, onA2);
e.on(shared, onShared);
e.on("plain", () => console.log("plain"));
e.on("0", () => console.log("zero"));
e.on("plain2", () => console.log("plain2"));

// Each symbol is its own event; Symbol.for() names match by registry entry.
e.emit(a, 1);
e.emit(a2);
e.emit(Symbol.for("shared"));
e.emit("plain");
e.emit("0");
e.emit("plain2");
console.log(e.listenerCount(a), e.listenerCount(a2), e.listenerCount(shared));

// Node's key order: integer-index strings ascending, then other strings in
// insertion order, then symbols in insertion order.
console.log(e.eventNames().map(String).join(","));

// listeners()/rawListeners() answer the symbol's own list.
console.log(e.listeners(a).length, e.listeners(a)[0] === onA, e.rawListeners(a2).length);

// Removal by identity: a different Symbol("a") never matches.
e.removeListener(a2, onA2);
console.log(e.listenerCount(a2));
e.removeAllListeners(shared);
console.log(e.listenerCount(shared), e.eventNames().map(String).join(","));

// A once listener under a symbol name leaves the name in eventNames() only
// while it is registered.
const onceName = Symbol("once");
e.once(onceName, () => console.log("once"));
console.log(e.eventNames().map(String).join(","));
e.emit(onceName);
e.emit(onceName);
console.log(e.listenerCount(onceName));

// errorMonitor keeps working beside symbol names: it sees an 'error' emit
// that has no 'error' listener, and it is not itself an event name.
const monitor = new EventEmitter();
monitor.on(errorMonitor, (err: Error) => console.log("monitor", err.message));
monitor.on("error", (err: Error) => console.log("error", err.message));
monitor.on(a, () => {});
monitor.emit("error", new Error("watched"));
console.log(monitor.listenerCount(a));

// The warning names a symbol event as Symbol(description).
const leaky = new EventEmitter();
const noisy = Symbol("noisy");
leaky.setMaxListeners(1);
leaky.on(noisy, () => {});
leaky.on(noisy, () => {});
