// require("events") is the EventEmitter class. Assigned to an untyped
// binding or stored in an object, it stays a constructor: construction
// through it builds an emitter with the whole listener API, and identity,
// instanceof, typeof and .name agree with the class.
var EventEmitter = require("events"), ReleaseEmitter;
ReleaseEmitter = EventEmitter;

const e = new ReleaseEmitter();
e.on("x", (v) => console.log("x", v));
e.prependListener("x", (v) => console.log("first x", v));
e.once("x", (v) => console.log("once x", v));
console.log("emit", e.emit("x", 1), e.emit("x", 2), e.emit("missing"));
console.log("count", e.listenerCount("x"), e.eventNames(), e.getMaxListeners());
console.log("instanceof", e instanceof EventEmitter, e instanceof ReleaseEmitter);
console.log("identity", ReleaseEmitter === EventEmitter, ReleaseEmitter !== EventEmitter);
console.log("typeof", typeof ReleaseEmitter, ReleaseEmitter.name);

const holder = { E: EventEmitter };
const h = new holder.E();
h.on("error", (err) => console.log("error", err.message));
h.emit("error", new Error("boom"));
console.log("holder", h instanceof EventEmitter, h instanceof holder.E, holder.E === EventEmitter);

try {
  new ReleaseEmitter().emit("error", new Error("unhandled"));
} catch (err) {
  console.log("caught", err.message);
}
e.removeAllListeners("x");
console.log("removed", e.listenerCount("x"), e.emit("x", 3));

// The left operand evaluates before the right-hand side assigns its
// variable.
var tested = new ReleaseEmitter();
console.log("left first", tested instanceof ((tested = 1), ReleaseEmitter), tested);
