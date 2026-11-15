// EventEmitter's own bookkeeping events: 'newListener' fires before a
// listener is added and 'removeListener' after one is removed, for on,
// once and off, with the event name and the listener.
import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
const log: string[] = [];
emitter.on("newListener", (name, listener) => {
  log.push("new " + String(name) + " " + typeof listener + " " + emitter.listenerCount(name));
});
emitter.on("removeListener", (name, listener) => {
  log.push("removed " + String(name) + " " + typeof listener + " " + emitter.listenerCount(name));
});

const first = (): void => {};
const second = (): void => {};
emitter.on("x", first);
emitter.once("x", second);
emitter.off("x", first);
emitter.emit("x");
emitter.on("y", first);
emitter.removeAllListeners("y");
console.log(log.join("\n"));
console.log(emitter.eventNames().map(String).join(","), emitter.listenerCount("x"), emitter.listenerCount("y"));
