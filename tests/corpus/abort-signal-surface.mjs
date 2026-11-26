// AbortController and AbortSignal: the abort reason defaults and overrides,
// the dispatch of listeners and the onabort handler, throwIfAborted,
// AbortSignal.abort()/timeout()/any() (including Node's sequence and
// element validation messages for any()), and the composite's reason.
const controller = new AbortController();
console.log("initial", controller.signal.aborted, controller.signal.reason);
let calls = 0;
const listener = () => calls++;
controller.signal.addEventListener("abort", listener);
controller.signal.addEventListener("abort", listener);
let onabortThis = null;
controller.signal.onabort = function () {
  onabortThis = this === controller.signal;
};
controller.abort();
console.log(
  "aborted",
  controller.signal.aborted,
  controller.signal.reason.name,
  controller.signal.reason.message,
  controller.signal.reason.code,
  calls,
  onabortThis,
);
try {
  controller.signal.throwIfAborted();
} catch (caught) {
  console.log("throwIfAborted", caught === controller.signal.reason);
}
controller.abort("ignored");
console.log("second abort", controller.signal.reason.name, calls);

const custom = new AbortController();
custom.abort("why");
console.log("custom reason", JSON.stringify(custom.signal.reason));
const withEvent = new AbortController();
const event = new Event("abort");
let eventArgument = null;
withEvent.signal.addEventListener("abort", (caught) => {
  eventArgument = caught.type;
});
withEvent.abort(event);
console.log("event reason", withEvent.signal.reason === event, eventArgument);

const late = new AbortController();
late.abort("r");
let lateCalls = 0;
late.signal.addEventListener("abort", () => lateCalls++);
console.log("late listener", lateCalls);

const once = new AbortController();
let onceCalls = 0;
once.signal.addEventListener("abort", () => onceCalls++, { once: true });
once.abort();
once.abort();
console.log("once", onceCalls);

const immediate = AbortSignal.abort();
console.log("abort static", immediate.aborted, immediate.reason.name, immediate.reason.message);
try {
  AbortSignal.timeout(0);
} catch (caught) {
  console.log("timeout 0", caught.constructor.name, caught.code);
}
try {
  AbortSignal.timeout(-1);
} catch (caught) {
  console.log("timeout -1", caught.constructor.name, caught.code);
}
const timed = AbortSignal.timeout(1);
await new Promise((resolve) => setTimeout(resolve, 30));
console.log("timeout fired", timed.aborted, timed.reason.name, timed.reason.code);

const a = new AbortController();
const b = new AbortController();
const composite = AbortSignal.any([a.signal, b.signal]);
let compositeCalls = 0;
composite.addEventListener("abort", () => compositeCalls++);
b.abort("from-b");
a.abort("from-a");
console.log(
  "any",
  composite.aborted,
  compositeCalls,
  composite.reason === b.signal.reason,
  composite.reason,
);
const single = new AbortController();
console.log("any single identity", AbortSignal.any([single.signal]) === single.signal);
console.log("any empty", AbortSignal.any([]).aborted);
const setComposite = AbortSignal.any(new Set([new AbortController().signal]));
console.log("any set", setComposite.aborted);

// A typed array is an iterable sequence of numbers (so an element fails);
// a DataView and the ArrayBuffer objects are not sequences at all. The
// calls go through an any-typed parameter, as a JavaScript source passes
// what its declarations do not name (Node reads the value at run time).
const outcome = (fn) => {
  try {
    return String(fn().aborted);
  } catch (caught) {
    return `${caught.constructor.name} ${caught.code} ${caught.message}`;
  }
};
const anyOf = (value) => AbortSignal.any(value);
console.log("any uint8 empty", outcome(() => anyOf(new Uint8Array(0))));
console.log("any uint8 element", outcome(() => anyOf(new Uint8Array([1]))));
console.log("any float64 empty", outcome(() => anyOf(new Float64Array(0))));
console.log("any buffer empty", outcome(() => anyOf(Buffer.alloc(0))));
console.log("any dataview", outcome(() => anyOf(new DataView(new ArrayBuffer(0)))));
console.log("any arraybuffer", outcome(() => anyOf(new ArrayBuffer(0))));
console.log("any shared", outcome(() => anyOf(new SharedArrayBuffer(0))));

const message = (fn) => {
  try {
    fn();
    return "accepted";
  } catch (caught) {
    return `${caught.constructor.name} ${caught.code} ${caught.message}`;
  }
};
const one = new AbortController().signal;
console.log("any number", message(() => AbortSignal.any(5)));
console.log("any string", message(() => AbortSignal.any("ab")));
console.log("any undefined", message(() => AbortSignal.any(undefined)));
console.log("any noargs", message(() => AbortSignal.any()));
console.log("any first", message(() => AbortSignal.any([1])));
console.log("any second", message(() => AbortSignal.any([one, {}])));
console.log("any controller", message(() => AbortSignal.any([new AbortController()])));
console.log("any nested", message(() => AbortSignal.any([[one]])));
