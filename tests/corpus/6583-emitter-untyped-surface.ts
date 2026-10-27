// The EventEmitter surface beyond on/once/emit/off called through untyped
// references to compiled emitters (a subclass instance and a plain
// EventEmitter): listenerCount, eventNames, listeners, rawListeners,
// removeAllListeners, setMaxListeners and getMaxListeners answer Node's
// results, and the chaining forms return the emitter.
import { EventEmitter } from "node:events";

class Bus extends EventEmitter {
  ping(n: number): boolean {
    return this.emit("ping", n);
  }
}
const b = new Bus();
const u: unknown = b;
const d = u as any;
const f = (n: any): void => console.log("f", n);
d.on("ping", f);
d.prependOnceListener("ping", (n: any) => console.log("once first", n));
d.prependListener("ping", (n: any) => console.log("first", n));
console.log(d.listenerCount("ping"), d.listenerCount("ping", f), d.listenerCount("none"));
console.log(d.eventNames(), d.listenerCount());
const all = d.listeners("ping");
console.log(all.length, d.rawListeners("ping").length, all[2] === f, typeof all[0]);
console.log(d.listeners("none"));
console.log(d.getMaxListeners(), d.setMaxListeners(2) === d, b.getMaxListeners());
console.log(b.ping(1), b.ping(2));
try {
  d.setMaxListeners(-1);
} catch (err: any) {
  console.log(err.name, err.code, err.message);
}
try {
  d.setMaxListeners("x");
} catch (err: any) {
  console.log(err.name, err.code, err.message);
}
d.on("other", () => {});
console.log(d.removeAllListeners("ping") === d, d.eventNames());
console.log(d.removeAllListeners() === d, d.eventNames(), d.listenerCount("other"));
console.log(b.ping(3));

const plain: any = new EventEmitter();
plain.on("x", () => {});
plain.on("y", () => {});
console.log(plain.eventNames(), plain.getMaxListeners(), plain.listeners("x").length);
plain.setMaxListeners(0);
console.log(plain.getMaxListeners(), plain.removeAllListeners("x").eventNames());
