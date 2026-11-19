// @requires-libnode
// A Proxy crosses into a Node island by reference: a callable Proxy runs its apply trap, a read
// runs its get trap (and not its has trap), and a symbol-keyed write reaches its set trap.
import { requireModule } from "@scriptc/node";

const calls = [];
const doubled = new Proxy(function (x) { return x * 2; }, {
  apply(target, thisArg, args) {
    calls.push("apply:" + args.join(","));
    return Reflect.apply(target, thisArg, args) + 1;
  },
});

const has = [];
const view = new Proxy({ a: 1 }, {
  get(target, key) {
    if (key === "missing") return "from-get";
    return Reflect.get(target, key);
  },
  has(target, key) {
    has.push(String(key));
    return Reflect.has(target, key);
  },
});

const writes = [];
const store = new Proxy({}, {
  set(target, key, value) {
    writes.push(typeof key === "symbol" ? key.description : String(key));
    return Reflect.set(target, key, value);
  },
});

const island = requireModule("./island.mjs");
console.log("call:", island.call(doubled, 20), calls.join(","));
console.log("get:", island.read(view, "a"), island.read(view, "missing"), "has:" + has.join(","));
const key = Symbol.for("node-island-proxy.symbol");
console.log("write:", island.write(store, key, 7), writes.join(","));
