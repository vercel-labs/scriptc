// The EventTarget, Event and CustomEvent surface: dispatchEvent's boolean
// result (false only for a prevented cancelable event), a listener object
// with handleEvent, the { once, capture, passive, signal } listener options,
// an aborted signal removing its listener, preventDefault and the Event
// state it changes, target/currentTarget/srcElement/eventPhase inside and
// outside a dispatch, CustomEvent's detail with the constructor options
// (bubbles, cancelable, composed), Event's defaults, composedPath, the stop
// methods, cancellation and the timestamp.
const target = new EventTarget();
const log: string[] = [];
const handler = (event: Event): void => {
  log.push(
    `h ${event.type} ${event.eventPhase} ${event.target === target} ${event.currentTarget === target}`,
  );
};
target.addEventListener("go", handler);
console.log("dispatch", target.dispatchEvent(new Event("go")));
target.removeEventListener("go", handler);
console.log("after remove", target.dispatchEvent(new Event("go")), log.join(" | "));

const onceTarget = new EventTarget();
let onceCount = 0;
onceTarget.addEventListener("o", () => void onceCount++, { once: true });
onceTarget.dispatchEvent(new Event("o"));
onceTarget.dispatchEvent(new Event("o"));
console.log("once", onceCount);

const objectTarget = new EventTarget();
const object = { handleEvent(event: Event): void { console.log("handled", event.type); } };
objectTarget.addEventListener("x", object);
objectTarget.dispatchEvent(new Event("x"));
objectTarget.removeEventListener("x", object);
objectTarget.dispatchEvent(new Event("x"));

const cancelTarget = new EventTarget();
cancelTarget.addEventListener("c", (event: Event) => {
  event.preventDefault();
  console.log("preventDefault", event.defaultPrevented, event.cancelBubble, event.returnValue);
});
console.log("cancelable dispatch", cancelTarget.dispatchEvent(new Event("c", { cancelable: true })));
console.log("plain dispatch", cancelTarget.dispatchEvent(new Event("c")));

const custom = new CustomEvent("hello", {
  detail: { n: 7 },
  bubbles: true,
  cancelable: true,
  composed: true,
});
console.log("custom", custom.type, JSON.stringify(custom.detail), custom.bubbles, custom.cancelable, custom.composed);
const plain = new Event("plain");
console.log("defaults", plain.bubbles, plain.cancelable, plain.composed, plain.isTrusted);
console.log("path", custom.composedPath().length);
plain.stopImmediatePropagation();
console.log("stop", plain.cancelBubble);
console.log("timestamp", typeof new Event("t").timeStamp, new Event("t").timeStamp > 0);

const event = new Event("x");
console.log("outside", event.target, event.currentTarget, event.srcElement, event.eventPhase);
const inner = new EventTarget();
inner.addEventListener("x", (dispatched: Event) => {
  console.log(
    "inside",
    dispatched.target === inner,
    dispatched.currentTarget === inner,
    dispatched.srcElement === inner,
    dispatched.eventPhase,
  );
});
inner.dispatchEvent(event);

const captureTarget = new EventTarget();
let captureCount = 0;
captureTarget.addEventListener("c", () => void captureCount++, true);
captureTarget.dispatchEvent(new Event("c"));
console.log("capture", captureCount);
const passiveTarget = new EventTarget();
passiveTarget.addEventListener("p", () => console.log("passive"), { passive: true });
passiveTarget.dispatchEvent(new Event("p"));

const signalTarget = new EventTarget();
const controller = new AbortController();
let signalCount = 0;
signalTarget.addEventListener("s", () => void signalCount++, { signal: controller.signal });
signalTarget.dispatchEvent(new Event("s"));
controller.abort();
signalTarget.dispatchEvent(new Event("s"));
console.log("signal", signalCount);
