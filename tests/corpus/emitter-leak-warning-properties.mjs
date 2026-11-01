// @normalize-pid
// The leak warning is Node's MaxListenersExceededWarning error with its own
// `emitter`, `type` and `count` properties: the emitter the listeners were
// added to (the same object, for a compiled subclass, a bare EventEmitter
// and an emitter built through an untyped constructor, and one that answers
// `instanceof EventEmitter`), the event name
// ARGUMENT (`on(null)` warns with `type: null`, though the table keys it
// as "null"; a symbol stays the same symbol) and the listener count at the
// crossing add. The message and the stderr report are unchanged.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {}

function noop() {}

const bus = new Bus();
bus.setMaxListeners(1);
const plain = new EventEmitter();
plain.setMaxListeners(2);
const Untyped = EventEmitter;
const dynamic = new Untyped();
dynamic.setMaxListeners(1);
const UntypedNull = EventEmitter;
const dynamicNull = new UntypedNull();
dynamicNull.setMaxListeners(1);
const shared = Symbol.for("shared");
const named = new EventEmitter();
named.setMaxListeners(1);
const nullName = new EventEmitter();
nullName.setMaxListeners(1);
const numberName = new EventEmitter();
numberName.setMaxListeners(1);

process.on("warning", (warning) => {
  console.log("warning", warning.name, warning instanceof Error);
  console.log("type", String(warning.type), typeof warning.type);
  console.log("count", warning.count);
  let which = "other";
  if (warning.emitter === bus) which = "bus";
  else if (warning.emitter === plain) which = "plain";
  else if (warning.emitter === dynamic) which = "dynamic";
  else if (warning.emitter === dynamicNull) which = "dyn-null";
  else if (warning.emitter === named) which = "named";
  else if (warning.emitter === nullName) which = "null";
  else if (warning.emitter === numberName) which = "number";
  console.log("emitter", which);
  console.log("instanceof", warning.emitter instanceof EventEmitter);
  if (warning.type === shared) console.log("symbol type identity", which === "named");
});

// The crossing add warns once per (emitter, name): the second add under
// max 1, the third under max 2, and one more add warns no further.
bus.on("data", noop);
bus.on("data", noop);
bus.on("data", noop);
plain.on("x", noop);
plain.on("x", noop);
plain.on("x", noop);
plain.on("x", noop);
dynamic.on("y", noop);
dynamic.on("y", noop);
dynamicNull.on(null, noop);
dynamicNull.on(null, noop);
named.on(shared, noop);
named.on(shared, noop);
nullName.on(null, noop);
nullName.on(null, noop);
numberName.on(5, noop);
numberName.on(5, noop);

console.log("counts", bus.listenerCount("data"), plain.listenerCount("x"), named.listenerCount(shared));
