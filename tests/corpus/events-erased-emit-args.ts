// Typed emit sites reach listeners registered through untyped values: an
// emitter's listener list is shared, so a listener whose registration went
// through a dynamic call receives the emitted arguments. Node is the oracle.
import { EventEmitter } from "node:events";

class Item {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
  twice(): number {
    return this.n * 2;
  }
}

class Bus extends EventEmitter {
  ping(v: { a: number; b: string }, ok: boolean): boolean {
    return this.emit("ping", v, ok);
  }
  tick(): boolean {
    return this.emit("tick");
  }
  item(it: Item): boolean {
    return this.emit("item", it);
  }
}

// The receiver is a checked-dynamic value inside the helper, so the listener
// lands in the shared list without a typed adapter of its own.
function register(target: any, name: string, fn: any): void {
  target.on(name, fn);
}

const bus = new Bus();
const seen: any[] = [];
register(bus, "ping", (v: any, ok: any) => {
  seen.push([v.a, v.b, ok]);
});
register(bus, "tick", () => {
  seen.push("tick");
});
const item = new Item(21);
let same = false;
let twice = 0;
register(bus, "item", (it: any) => {
  same = it === item;
  twice = it.twice();
});
console.log(bus.ping({ a: 1, b: "two" }, true));
console.log(bus.tick());
console.log(bus.item(item));
console.log(JSON.stringify(seen));
console.log(`same ${same} twice ${twice}`);
