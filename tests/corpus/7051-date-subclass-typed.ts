// A TypeScript class that extends Date, and a subclass of it: typed calls
// of the inherited Date methods, conversions, comparisons, JSON and
// console output, with the toISOString override visible to toJSON.
class Stamp extends Date {
  #precise: boolean;
  label = "stamp";
  constructor(value: number | string, precise = false) {
    super(value);
    this.#precise = precise;
  }
  override toISOString(): string {
    const iso = super.toISOString();
    return this.#precise ? iso : iso.slice(0, 19) + "Z";
  }
  shifted(ms: number): Stamp {
    return new Stamp(this.getTime() + ms, this.#precise);
  }
}

class Tick extends Stamp {
  constructor(value: number) {
    super(value, true);
  }
  seconds(): number {
    return this.getUTCSeconds() + this.getUTCMilliseconds() / 1000;
  }
}

const a = new Stamp("2001-02-03T04:05:06.789Z");
const b = new Tick(1500);
console.log(a.toISOString(), b.toISOString(), a.getTime(), b.seconds());
console.log(a instanceof Date, b instanceof Stamp, b instanceof Date, a.shifted(1000).toISOString());
console.log(JSON.stringify({ a, b, list: [a] }), JSON.stringify(a), a.toJSON(), b.toJSON());
console.log(String(a).slice(0, 15), `${b}`.slice(0, 15), +a, b.valueOf(), a.getTime() - b.getTime());
console.log(a < b, a > b, a >= b, a == a, a + "!" === String(a) + "!");
console.log(a);
console.log([b], { b });
console.log(a.setTime(5000), a.getTime(), a.toISOString(), a.label);

const items: Stamp[] = [a, b, new Tick(0)];
items.sort((x, y) => x.getTime() - y.getTime());
console.log(items.map((s) => s.toISOString()).join(","));
console.log(items.filter((s) => s instanceof Tick).length);
function describe(value: Stamp | string): string {
  return typeof value === "string" ? value : value.toISOString();
}
console.log(describe(b), describe("text"));
