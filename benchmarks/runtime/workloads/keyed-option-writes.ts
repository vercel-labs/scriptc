// Class methods whose names are also keys of option records written through
// element accesses: `enabled[name] = true` over a union of literal names and
// `totals["count"] = n`. The writes store booleans and numbers into plain
// records, so the methods keep their native calls.
type Step = "scale" | "offset" | "clamp";

const enabled: Record<Step, boolean> = { scale: false, offset: false, clamp: false };
function enable(name: Step): void {
  enabled[name] = true;
}

const totals: Record<string, number> = {};

class Transform {
  private readonly factor: number;
  private readonly shift: number;
  constructor(factor: number, shift: number) {
    this.factor = factor;
    this.shift = shift;
  }
  scale(x: number): number {
    return enabled.scale ? x * this.factor : x;
  }
  offset(x: number): number {
    return enabled.offset ? x + this.shift : x;
  }
  clamp(x: number): number {
    if (!enabled.clamp) return x;
    return x < 0 ? 0 : x > 1000 ? 1000 : x;
  }
}

class Counter {
  private seen = 0;
  private sum = 0;
  add(value: number): void {
    this.seen++;
    this.sum += value;
  }
  count(): number {
    return this.seen;
  }
  mean(): number {
    return this.seen === 0 ? 0 : this.sum / this.seen;
  }
}

const scale = Number(process.argv[2] ?? "1");
const steps: Step[] = ["scale", "offset", "clamp"];
for (const step of steps) enable(step);

const transforms: Transform[] = [];
for (let i = 0; i < 16; i++) transforms.push(new Transform(1 + (i % 5) * 0.25, (i % 7) - 3));
const counters: Counter[] = [];
for (let i = 0; i < 8; i++) counters.push(new Counter());

let seed = 12345;
let checksum = 0;
const rounds = Math.floor(2_000_000 * scale);
for (let i = 0; i < rounds; i++) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  const t = transforms[seed & 15]!;
  const value = t.clamp(t.offset(t.scale((seed >>> 8) % 1200)));
  const counter = counters[(seed >>> 4) & 7]!;
  counter.add(value);
  checksum += value;
  if ((i & 65535) === 0) totals["count"] = counter.count();
}

let mean = 0;
let seen = 0;
for (const counter of counters) {
  mean += counter.mean();
  seen += counter.count();
}
console.log("seen", seen, "count", totals["count"], "mean", (mean / counters.length).toFixed(4), "checksum", checksum);
