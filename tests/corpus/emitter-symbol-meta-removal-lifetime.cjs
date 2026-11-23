// A symbol event name registered by a helper that has returned is owned by
// the emitter's listener bucket alone. Removing those listeners announces
// the removal to 'removeListener' listeners with the symbol itself, so the
// announcement must run while the name is still alive.
const { EventEmitter } = require("node:events");

const e = new EventEmitter();
const log = [];
e.on("removeListener", (name) => log.push(`removed:${String(name)}:${typeof name}`));

function registerTemporarily() {
  const sym = Symbol("tmp");
  e.on(sym, () => {});
  return e.listenerCount(sym);
}

console.log("count", registerTemporarily());
console.log("names", e.eventNames().length);
e.removeAllListeners();
console.log(log.join("|"), e.eventNames().length);

const f = new EventEmitter();
const seen = [];
f.on("removeListener", (name) => seen.push(String(name)));
const make = () => {
  const s = Symbol("other");
  const fn = () => {};
  f.on(s, fn);
  return fn;
};
make();
f.removeAllListeners();
console.log(seen.join(","), f.eventNames().length);
