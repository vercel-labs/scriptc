// An object literal with a computed key that is only known at runtime
// defines a property of that new object. Class methods, including methods
// of generic classes, keep their calls.
class Ctx<T = string> {
  v: number;
  constructor() {
    this.v = 0;
  }
  json(o: T): string {
    return JSON.stringify(o);
  }
  status(n: number): Ctx<T> {
    this.v = n;
    return this;
  }
}

class Counter {
  count = 0;
  bump(): number {
    return ++this.count;
  }
}

function headers(names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) Object.assign(out, { [name.toLowerCase()]: name.length });
  return out;
}

const prefix = process.argv.length > 99 ? "never" : "x-";
const key = `${prefix}id`;
const literal: Record<string, number> = { [key]: 1, [`${key}-2`]: 2 };
const ctx = new Ctx<{ ok: boolean }>();
const counter = new Counter();
counter.bump();
console.log(literal, headers(["Accept", "Host"]));
console.log(typeof ctx.json, typeof ctx.status, ctx.status(200).json({ ok: true }), ctx.v);
console.log(counter.bump(), counter.count);
