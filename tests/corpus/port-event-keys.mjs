// A MessagePort's event types follow Node's NodeEventTarget rules: on, once
// and off convert with the DOM string conversion (a number or an object
// becomes a string, a symbol is an ERR_INVALID_ARG_TYPE), removeAllListeners
// and listenerCount use the name's string form (so Symbol("s") names the
// string key "Symbol(s)"), and emit takes a string only.
import { MessageChannel } from "node:worker_threads";

const { port1 } = new MessageChannel();
const listener = () => console.log("called");
const show = (label, fn) => {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
};
show("on number", () => port1.on(7, listener) === port1);
show("count number", () => port1.listenerCount(7));
show("emit number", () => port1.emit(7));
show("on symbol", () => port1.on(Symbol("s"), listener));
show("once symbol", () => port1.once(Symbol("s"), listener));
show("off symbol", () => port1.off(Symbol("s"), listener));
show("emit symbol", () => port1.emit(Symbol("s")));
show("removeAll symbol", () => port1.removeAllListeners(Symbol("s")) === port1);
show("count symbol", () => port1.listenerCount(Symbol("s")));
show("on symbol key", () => port1.on("Symbol(s)", listener) === port1);
show("count symbol key", () => [
  port1.listenerCount(Symbol("s")),
  port1.eventNames().includes("Symbol(s)"),
]);
show("once symbol key", () => port1.once("Symbol(t)", listener) === port1);
show("count once key", () => port1.listenerCount(Symbol("t")));
show("removeAll symbol key", () => [
  port1.removeAllListeners(Symbol("s")) === port1,
  port1.listenerCount("Symbol(s)"),
]);
show("emit once key", () => [port1.emit("Symbol(t)"), port1.listenerCount("Symbol(t)")]);
show("on object", () => port1.on({ toString: () => "obj" }, listener) === port1);
show("emit object", () => port1.emit({}));
port1.close();
