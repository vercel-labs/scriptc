// `instanceof` on a value that is either a promise or an instance of one of
// the program's classes: each test picks its arm, the other arm is what is
// left, and the narrowed value is the same object (no copy), so a promise
// arm keeps its identity as a key and its place in the microtask order.
let tick = 0;
function spin(i: number): void {
  if (i < 8) {
    Promise.resolve().then(() => {
      tick++;
      spin(i + 1);
    });
  }
}

class Reading {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
// Declared and never constructed: the test against Reading still answers.
class Calibrated extends Reading {
  readonly offset = 1;
}
class Cached {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  then(onFulfilled: (value: number) => void): void {
    onFulfilled(this.value);
  }
}

type Source = Promise<number> | Reading;
type Lookup = Promise<number> | Cached;

const pendingBySource = new Map<Promise<number>, string>();
const seen = new WeakSet<Promise<number>>();

function classify(source: Source): string {
  if (source instanceof Reading) return "reading " + source.value;
  source.then((value) => console.log("  source settled", value, "tick", tick));
  return "promise";
}

function classifyByPromise(source: Source): string {
  if (source instanceof Promise) {
    pendingBySource.set(source, "kept");
    seen.add(source);
    return "promise";
  }
  return "reading " + source.value;
}

function negated(source: Source): string {
  if (!(source instanceof Reading)) return "not a reading";
  return "reading " + source.value;
}

function label(source: Source): string {
  return source instanceof Promise ? "promise" : source instanceof Reading ? "reading" : "neither";
}

function lookup(entry: Lookup): string {
  if (entry instanceof Cached) return "cached " + entry.value;
  entry.then((value) => console.log("  lookup settled", value, "tick", tick));
  return "promise";
}

function optional(source: Source | undefined): string {
  if (source instanceof Reading) return "reading " + source.value;
  if (source === undefined) return "absent";
  return source instanceof Promise ? "promise" : "unreachable";
}

function mixed(source: Source | string): string {
  if (source instanceof Reading) return "reading " + source.value;
  if (typeof source === "string") return "text " + source;
  return "promise";
}

interface Holder {
  readonly name: string;
  readonly source: Source;
}

function fromField(holder: Holder): string {
  return holder.name + ":" + (holder.source instanceof Reading ? "reading" : "promise");
}

function count(sources: Source[]): string {
  let readings = 0;
  let promises = 0;
  for (const source of sources) {
    if (source instanceof Reading) readings += 1;
    else if (source instanceof Promise) promises += 1;
  }
  return readings + " readings, " + promises + " promises";
}

async function settle(source: Source): Promise<number> {
  if (source instanceof Promise) {
    const value = await source;
    console.log("  awaited the promise arm", value, "tick", tick);
    return value;
  }
  console.log("  nothing to await, tick", tick);
  return source.value;
}

async function compute(): Promise<number> {
  return 12;
}

async function main(): Promise<void> {
  spin(0);
  const quick: Promise<number> = Promise.resolve(41);
  const made = compute();
  const reading = new Reading(3);

  console.log("classify", classify(reading), classify(quick), classify(made));
  console.log("by promise", classifyByPromise(quick), classifyByPromise(reading), classifyByPromise(quick));
  console.log("identity", pendingBySource.size, pendingBySource.get(quick) ?? "missing", seen.has(quick), seen.has(made));
  console.log("negated", negated(quick), negated(reading));
  console.log("label", label(quick), label(reading));
  console.log("lookup", lookup(new Cached(5)), lookup(quick));
  console.log("optional", optional(undefined), optional(reading), optional(quick));
  console.log("mixed", mixed("word"), mixed(reading), mixed(quick));
  console.log("field", fromField({ name: "a", source: reading }), fromField({ name: "b", source: made }));
  console.log("count", count([reading, quick, made, new Reading(4)]));
  console.log("settle", await settle(quick), await settle(reading), await settle(made));
  console.log("end tick", tick);
}

main();
