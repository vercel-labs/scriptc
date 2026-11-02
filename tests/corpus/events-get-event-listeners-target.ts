// events.getEventListeners over an EventTarget: the type's listeners in
// registration order, a type with none answering empty, a name that is not
// a string matching no type, a compiled subclass answering like the plain
// target, and Node's ERR_INVALID_ARG_TYPE for a value that is neither an
// EventEmitter nor an EventTarget. EventEmitters keep answering through
// their own listeners().
import { EventEmitter, getEventListeners } from "node:events";

function report(label: string, listeners: Array<() => void>, first?: object, second?: object) {
  const ids = [first, second].filter((value) => value !== undefined);
  console.log(label, listeners.length, listeners[0] === ids[0], listeners[1] === ids[1]);
}

const target = new EventTarget();
const first = () => {};
const second = () => {};
target.addEventListener("foo", first);
target.addEventListener("foo", second);
target.addEventListener("baz", first);
target.addEventListener("baz", first);

const foo = getEventListeners(target, "foo");
report("foo", foo, first, second);
report("bar", getEventListeners(target, "bar"));
report("baz", getEventListeners(target, "baz"), first);
console.log("symbol", getEventListeners(target, Symbol("foo")).length);
console.log("number", getEventListeners(target, 1 as unknown as string).length);

function listenerCount(value: EventTarget, type: string): number {
  return getEventListeners(value, type).length;
}
const name = "foo";
console.log("computed", listenerCount(target, name));

target.removeEventListener("foo", first);
report("after remove", getEventListeners(target, "foo"), second);

const onceTarget = new EventTarget();
const once = () => {};
onceTarget.addEventListener("x", once, { once: true });
report("once", getEventListeners(onceTarget, "x"), once);
onceTarget.dispatchEvent(new Event("x"));
report("after dispatch", getEventListeners(onceTarget, "x"));

class Bus extends EventTarget {}
const bus = new Bus();
bus.addEventListener("go", first);
bus.addEventListener("go", second);
report("subclass", getEventListeners(bus, "go"), first, second);

const controller = new AbortController();
const onAbort = () => {};
controller.signal.addEventListener("abort", onAbort);
report("signal", getEventListeners(controller.signal, "abort"), onAbort);

// The removal hook an options.signal registration adds is an abort
// listener of the signal, as in Node.
const hooked = new AbortController();
target.addEventListener("work", first, { signal: hooked.signal });
console.log("hook", getEventListeners(hooked.signal, "abort").length);
// The on<type> attribute registers a wrapper function of its own.
const attributed = new AbortController();
attributed.signal.onabort = first;
const wrappers = getEventListeners(attributed.signal, "abort");
console.log("attribute", wrappers.length, wrappers[0] === first);
attributed.signal.onabort = second;
console.log("replaced", getEventListeners(attributed.signal, "abort")[0] === wrappers[0]);

const emitter = new EventEmitter();
emitter.on("foo", first);
emitter.on("foo", second);
report("emitter", getEventListeners(emitter, "foo"), first, second);

function attempt(label: string, value: unknown) {
  try {
    getEventListeners(value as EventTarget, "foo");
    console.log(label, "no throw");
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(label, err.code, err.message);
  }
}
attempt("string", "INVALID_EMITTER");
attempt("plain object", {});
attempt("null", null);
attempt("undefined", undefined);
