// Node's runtime-provided host classes reached through a stored value: the
// value builds what the direct `new` builds, and calling one without `new`
// throws Node's class-constructor TypeError.
const Controller = AbortController;
const E = Event;
const CE = CustomEvent;
const ET = EventTarget;
const D = DOMException;

const controller = new Controller();
console.log(typeof controller.signal, controller.signal.aborted);

const event = new E("ping", { cancelable: true, bubbles: false });
console.log(event.type, event.cancelable, event.bubbles);

const custom = new CE("custom", { detail: 5 });
console.log(custom.type, custom.detail);

const target = new ET();
let seen = 0;
target.addEventListener("x", () => {
  seen += 1;
});
target.dispatchEvent(new E("x"));
console.log("dispatched", seen);

const error = new D("boom", "NotSupportedError");
console.log(error.name, error.message, error.code);

const callValue = (value) => value();
for (const ctor of [E, CE, ET, Controller, D]) {
  try {
    callValue(ctor);
  } catch (thrown) {
    console.log(thrown.name, thrown.message);
  }
}
