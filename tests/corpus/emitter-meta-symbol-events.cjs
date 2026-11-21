// The meta events fire for symbol-keyed events too: the affected event's
// name arrives as the symbol itself (Node passes the name VALUE, so a
// symbol name is the symbol, not "Symbol(desc)"), for on/once/prepend,
// off and removeAllListeners, beside the string names of other events.
const { EventEmitter } = require("node:events");

const e = new EventEmitter();
const log = [];
const meta = (tag) => (name) =>
  log.push(`${tag}:${String(name)}:${typeof name}`);
e.on("newListener", meta("+"));
e.on("removeListener", meta("-"));
e.on("newListener", (name) => log.push(`ident:${name === sym}`));

const sym = Symbol("id");
const other = Symbol();
const fn = () => {};
e.once(sym, fn);
e.prependListener(other, () => {});
e.addListener(sym, () => {});
e.emit(sym);
e.removeAllListeners(other);
e.off(sym, fn);
e.removeAllListeners();
console.log(log.join("|"));

const e2 = new EventEmitter();
const seen = [];
e2.on("newListener", (name) => seen.push(name === sym, typeof name));
e2.on(sym, () => {});
console.log(seen.join(","), e2.listenerCount(sym), e2.eventNames().length);
console.log(e2.eventNames()[1] === sym, String(e2.eventNames()[1]));

const e3 = new EventEmitter();
const names = [];
e3.on("newListener", (name) => names.push(String(name)));
e3.on("str", () => {});
e3.emit("str");
console.log(names.join(","));
