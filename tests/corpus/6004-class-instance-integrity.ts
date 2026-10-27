export {};
import { inspect } from "node:util";

const message = (run: () => void): string => {
  try {
    run();
    return "no error";
  } catch (e) {
    return `${e instanceof TypeError ? "TypeError" : "Error"}: ${(e as Error).message}`;
  }
};

class Point {
  x = 1;
  y = 2;
  label = "p";
  move(dx: number): void {
    this.x += dx;
  }
}

const p = new Point();
console.log(Object.isFrozen(p), Object.isSealed(p), Object.isExtensible(p));
const same = Object.freeze(p);
console.log(same === p, Object.isFrozen(p), Object.isSealed(p), Object.isExtensible(p));
console.log(message(() => {
  p.x = 5;
}));
console.log(message(() => p.move(1)));
console.log(p.x, Object.keys(p));
const q = new Point();
q.x = 9;
console.log(q.x, Object.isFrozen(q));

class Point3 extends Point {
  z = 3;
}
const p3 = new Point3();
Object.freeze(p3);
console.log(message(() => {
  p3.z = 1;
}));
const asBase: Point = new Point3();
Object.freeze(asBase);
console.log(message(() => {
  asBase.y = 0;
}));
console.log(asBase.y);

class Counter {
  n = 0;
}
const c = Object.seal(new Counter());
c.n = 5;
console.log(c.n, Object.isSealed(c), Object.isFrozen(c), Object.isExtensible(c));
const d = new Counter();
Object.preventExtensions(d);
d.n = 2;
console.log(d.n, Object.isExtensible(d), Object.isSealed(d), Object.isFrozen(d));
const loose: any = d;
console.log(message(() => {
  loose.extra = 1;
}));

class Config {
  mode = "dev";
  level = 1;
}
const cfg = new Config();
Object.defineProperty(cfg, "mode", { value: "prod", writable: false });
console.log(cfg.mode, Object.keys(cfg), Object.values(cfg));
console.log(message(() => {
  cfg.mode = "x";
}));
Object.defineProperty(cfg, "level", { enumerable: false });
console.log(Object.keys(cfg), Object.entries(cfg), cfg.level);
Object.defineProperty(cfg, "level", { configurable: false });
console.log(message(() => Object.defineProperty(cfg, "level", { enumerable: true })));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(cfg, "mode")));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(cfg, "level")));
cfg.level = 7;
console.log(cfg.level);

const fz = Object.freeze(new Config());
console.log(message(() => Object.defineProperty(fz, "level", { value: 2 })));
console.log(message(() => Object.defineProperty(fz, "level", { value: 1 })));
console.log(fz.level, JSON.stringify(Object.getOwnPropertyDescriptor(fz, "level")));

class Frozen {
  a = 1;
  constructor() {
    Object.freeze(this);
  }
}
const frozenInCtor = new Frozen();
console.log(frozenInCtor.a, Object.isFrozen(frozenInCtor));
console.log(message(() => {
  frozenInCtor.a = 2;
}));

class Extended extends Frozen {
  b = 2;
}
console.log(message(() => new Extended()));

class Empty {}
const empty = new Empty();
console.log(Object.isExtensible(empty), Object.isSealed(empty), Object.isFrozen(empty));
Object.preventExtensions(empty);
console.log(Object.isExtensible(empty), Object.isSealed(empty), Object.isFrozen(empty));

class Totals {
  count = 1;
  items: string[] = [];
}
const t = new Totals();
Object.freeze(t);
console.log(message(() => {
  t.count += 1;
}));
console.log(message(() => {
  t.count++;
}));
console.log(message(() => {
  ({ value: t.count } = { value: 5 });
}));
t.items.push("still mutable");
console.log(t.count, t.items, Object.isFrozen(t.items));
console.log(JSON.stringify(Object.getOwnPropertyDescriptor(t, "count")));

class Holder<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
}
const h = Object.freeze(new Holder("text"));
console.log(h.value, Object.isFrozen(h));
const h2 = new Holder(4);
Object.seal(h2);
h2.value = 5;
console.log(h2.value, Object.isSealed(h2));

class Settings {
  mode = "dev";
  level = 1;
}
const settings = new Settings();
console.log(settings);
Object.defineProperty(settings, "level", { enumerable: false });
console.log(settings, inspect(settings));
console.log([settings], { settings });

class Pair {
  x = 1;
  y = 2;
}
const pair = new Pair();
Object.freeze(pair);
console.log(pair, Object.isFrozen(pair));
const sealed = new Pair();
(sealed as any).extra = "added";
Object.seal(sealed);
console.log(sealed, Object.isSealed(sealed));

// JSON.stringify reads the same view: non-enumerable fields are skipped.
console.log(JSON.stringify(cfg), JSON.stringify(settings));
console.log(JSON.stringify({ settings, pair, sealed }));
console.log(JSON.stringify([fz, t]));
