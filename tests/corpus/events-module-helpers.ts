// The events module's helpers answer for EventTargets as well as emitters:
// listenerCount, getMaxListeners, setMaxListeners and getEventListeners
// read and write an EventTarget's own listener state, a listener object
// with handleEvent included, and a plain target's max listeners start at
// the process default. On an emitter a once listener is seen as the
// function it wraps.
import {
  EventEmitter,
  defaultMaxListeners,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  setMaxListeners,
} from "node:events";

const emitter = new EventEmitter();
const named = (): void => {};
const anonymous = (): void => {};
emitter.on("x", named);
emitter.once("x", anonymous);
console.log("emitter count", listenerCount(emitter, "x"), emitter.listenerCount("x"));
const listeners = getEventListeners(emitter, "x");
console.log("emitter listeners", listeners.length, listeners[0] === named, listeners[1] === anonymous);
console.log("emitter max", getMaxListeners(emitter), emitter.getMaxListeners());
setMaxListeners(12, emitter);
console.log("emitter max after set", getMaxListeners(emitter));
console.log("missing", listenerCount(emitter, "missing"), getEventListeners(emitter, "missing").length);

const target = new EventTarget();
const object = { handleEvent(event: Event): void { console.log("handled", event.type); } };
const plain = (): void => {};
target.addEventListener("go", object);
target.addEventListener("go", plain);
console.log("target count", listenerCount(target, "go"), getMaxListeners(target), defaultMaxListeners);
const targetListeners = getEventListeners(target, "go");
console.log(
  "target listeners",
  targetListeners.length,
  targetListeners[0] === object,
  typeof targetListeners[0],
  typeof targetListeners[1],
);
setMaxListeners(3, target);
console.log("target max after set", getMaxListeners(target));
target.dispatchEvent(new Event("go"));
target.removeEventListener("go", object);
console.log("target count after remove", listenerCount(target, "go"));
console.log("target missing", listenerCount(target, "missing"));

setMaxListeners(2, emitter, target);
console.log("both max", getMaxListeners(emitter), getMaxListeners(target));
