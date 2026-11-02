// events.getMaxListeners and events.setMaxListeners over EventTargets: a
// target starts at 10 and an AbortSignal at 0, a limit set through the
// helper reads back through it, every target of one call is set, a later
// bad target leaves the earlier ones set, the limit is validated before
// any receiver is looked at, a compiled subclass answers like the plain
// target, and Node's errors for the receivers it does not take (the
// getMaxListeners read is optional-chained, so null and undefined are an
// ERR_INVALID_ARG_TYPE there, while setMaxListeners reads the property and
// throws its plain TypeError). EventEmitters keep their own methods.
import { EventEmitter, getMaxListeners, setMaxListeners } from "node:events";

const target = new EventTarget();
const controller = new AbortController();
console.log("default", getMaxListeners(target), getMaxListeners(controller.signal));

setMaxListeners(3, target);
console.log("set target", getMaxListeners(target));

setMaxListeners(5, controller.signal);
console.log("set signal", getMaxListeners(controller.signal));

const other = new EventTarget();
setMaxListeners(7, target, other);
console.log("two", getMaxListeners(target), getMaxListeners(other));

setMaxListeners(0, target);
console.log("zero", getMaxListeners(target));

setMaxListeners(1.5, target);
console.log("fractional", getMaxListeners(target));

class Bus extends EventTarget {}
const bus = new Bus();
console.log("subclass default", getMaxListeners(bus));
setMaxListeners(4, bus);
console.log("subclass set", getMaxListeners(bus));

const emitter = new EventEmitter();
emitter.setMaxListeners(2);
console.log("emitter", getMaxListeners(emitter));
setMaxListeners(6, emitter, bus);
console.log("mixed", getMaxListeners(emitter), getMaxListeners(bus));

function attempt(label: string, run: () => unknown) {
  try {
    console.log(label, run());
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(label, err.code, err.message);
  }
}

attempt("negative limit", () => {
  setMaxListeners(-1, target);
  return getMaxListeners(target);
});
attempt("NaN limit", () => {
  setMaxListeners(NaN, target);
  return getMaxListeners(target);
});
function setMaxNegative(value: unknown) {
  setMaxListeners(-1, value as EventTarget);
}
attempt("validated before receiver", () => {
  setMaxNegative({});
  return "no throw";
});
function setMaxPair(first: EventTarget, second: unknown) {
  setMaxListeners(9, first, second as EventTarget);
}
attempt("bad target after good", () => {
  const first = new EventTarget();
  try {
    setMaxPair(first, {});
  } catch (e) {
    console.log("inner", (e as Error & { code?: string }).code);
  }
  return getMaxListeners(first);
});

function max(value: unknown) {
  return getMaxListeners(value as EventTarget);
}
function setMax(value: unknown) {
  setMaxListeners(3, value as EventTarget);
}
attempt("max string", () => max("name"));
attempt("max number", () => max(42));
attempt("max null", () => max(null));
attempt("max undefined", () => max(undefined));
attempt("set null", () => setMax(null));
attempt("set undefined", () => setMax(undefined));
attempt("set number", () => setMax(42));
attempt("set plain object", () => setMax({}));
