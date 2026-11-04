// events.listenerCount over an EventTarget: the type's listener count, a
// duplicate registration counting once, capture and once as distinct
// registrations, a type with none answering 0, a type that is not a string
// finding none, a compiled subclass and an AbortSignal answering like the
// plain target, and Node's errors for a value that is neither an
// EventEmitter nor an EventTarget (the null and undefined receiver throws
// the plain TypeError of the 'listenerCount' read). EventEmitters keep
// answering through their own listenerCount method.
import { EventEmitter, listenerCount } from "node:events";

const target = new EventTarget();
const listener = () => {};
target.addEventListener("foo", listener);
target.addEventListener("foo", listener);
target.addEventListener("foo", listener, { once: true });
target.addEventListener("bar", listener, { capture: true });
target.addEventListener("bar", listener);

console.log("foo", listenerCount(target, "foo"));
console.log("bar", listenerCount(target, "bar"));
console.log("none", listenerCount(target, "zzz"));
console.log("symbol", listenerCount(target, Symbol("foo")));
console.log("number", listenerCount(target, 1 as unknown as string));

const name = "foo";
function count(value: EventTarget, type: string): number {
  return listenerCount(value, type);
}
console.log("computed", count(target, name));

target.removeEventListener("bar", listener, { capture: true });
console.log("after remove", listenerCount(target, "bar"));

const onceTarget = new EventTarget();
onceTarget.addEventListener("x", listener, { once: true });
console.log("once", listenerCount(onceTarget, "x"));
onceTarget.dispatchEvent(new Event("x"));
console.log("after dispatch", listenerCount(onceTarget, "x"));

class Bus extends EventTarget {}
const bus = new Bus();
bus.addEventListener("go", listener);
bus.addEventListener("go", () => {});
console.log("subclass", listenerCount(bus, "go"));

const controller = new AbortController();
controller.signal.addEventListener("abort", listener);
console.log("signal", listenerCount(controller.signal, "abort"));

const emitter = new EventEmitter();
emitter.on("foo", listener);
emitter.once("foo", listener);
console.log("emitter", listenerCount(emitter, "foo"));

function attempt(label: string, value: unknown) {
  try {
    console.log(label, listenerCount(value as EventTarget, "foo"));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(label, err.code, err.message);
  }
}
attempt("string receiver", "name");
attempt("plain object", {});
attempt("number", 42);
attempt("null", null);
attempt("undefined", undefined);
