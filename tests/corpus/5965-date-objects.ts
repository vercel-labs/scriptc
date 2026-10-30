// Dates are objects with identity: arrays of Dates, `Date | undefined`
// and `Date | null` slots, === by identity, includes/indexOf/lastIndexOf,
// at/find/pop answering undefined, Map and Set keys and values, join,
// String() and default sort through toString(), and Dates in records,
// tuples, class fields, closures, async results and generators.
export {};
process.env.TZ = "America/Chicago";

const base = new Date(Date.UTC(2026, 3, 1, 12));
const same = base;
const copy = new Date(base);
const equalTime = new Date(base.getTime());
console.log(base === same, base === copy, copy === equalTime, base !== copy);
console.log(copy.getTime() === base.getTime(), base < new Date(base.getTime() + 1), base >= copy);

// Arrays.
const dates: Date[] = [base, new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1))];
console.log(dates.length, dates.includes(base), dates.includes(copy), dates.indexOf(dates[2]!));
console.log(dates.indexOf(equalTime), dates.lastIndexOf(base), dates.indexOf(base, 1));
console.log(dates.join(" | "));
console.log(String(dates));
console.log(`${dates}`);
console.log([...dates].sort().map((d) => d.toISOString()));
console.log(dates.toSorted((a, b) => a.getTime() - b.getTime()).map((d) => d.getUTCFullYear()));
const first = dates.at(0);
const missing = dates.at(10);
console.log(first === base, missing, missing === undefined, first?.toISOString(), missing?.toISOString());
const found = dates.find((d) => d.getUTCFullYear() === 2025);
console.log(found === dates[1], dates.find((d) => d.getTime() < 0), dates.findLast((d) => d > base));
const stack = [...dates];
console.log(stack.pop() === dates[2], stack.pop()?.getUTCFullYear(), stack.pop() === base, stack.pop());
const latest = dates.reduce((m, d) => (d > m ? d : m));
console.log(latest === base, dates.filter((d) => d < base).length, dates.map((d) => d.getUTCMonth()));
const grid: Date[][] = [[base], [copy, base]];
console.log(grid[1]!.indexOf(base), grid.flat().length, grid.flat().includes(copy));
const holes: (Date | undefined)[] = [base, undefined, copy];
console.log(holes.join(","), holes.indexOf(undefined), holes.filter((d) => d !== undefined).length);

// Nullable slots.
let maybe: Date | null = null;
console.log(maybe === null, maybe);
maybe = base;
console.log(maybe === base, maybe.getUTCHours());
function stamp(d?: Date): string {
  return d === undefined ? "none" : d.toISOString();
}
function withDefault(d: Date = new Date(0)): number {
  return d.getTime();
}
console.log(stamp(), stamp(base), withDefault(), withDefault(base) === base.getTime());

// Collections.
const notes = new Map<Date, string>([[base, "base"]]);
notes.set(copy, "copy");
console.log(notes.get(base), notes.get(copy), notes.get(equalTime), notes.size);
const byName = new Map<string, Date>([["start", base]]);
console.log(byName.get("start") === base, byName.get("end"));
const seen = new Set<Date>([base, same, copy]);
console.log(seen.size, seen.has(base), seen.has(equalTime));

// Records, tuples, classes and closures.
interface Event {
  name: string;
  at: Date;
  ends?: Date;
}
const events: Event[] = [
  { name: "a", at: base },
  { name: "b", at: copy, ends: base },
];
console.log(events.map((e) => `${e.name}@${e.at.toISOString()} ends=${e.ends?.toISOString() ?? "-"}`));
console.log(events[1]!.ends === events[0]!.at, events[1]!.at === events[0]!.at);
const pair: [Date, string] = [base, "x"];
console.log(pair[0] === base, pair[1]);
class Window {
  from: Date;
  to: Date | null = null;
  later!: Date;
  constructor(from: Date) {
    this.from = from;
  }
  span(): number {
    return this.to === null ? 0 : this.to.getTime() - this.from.getTime();
  }
}
const w = new Window(base);
w.later = copy;
console.log(w.span(), w.later === copy);
w.to = new Date(base.getTime() + 60000);
console.log(w.span(), w.to === w.from);
let captured: Date | undefined;
const remember = (d: Date): void => {
  captured = d;
};
remember(base);
console.log(captured === base, captured?.getUTCDate());

// Async results, generators and unknown.
async function later(d: Date): Promise<Date> {
  await null;
  return new Date(d.getTime() + 1);
}
const next = await later(base);
console.log(next.getTime() - base.getTime(), next === base);
function* ticks(start: Date, n: number): Generator<Date, void, unknown> {
  for (let i = 0; i < n; i++) yield new Date(start.getTime() + i * 1000);
}
console.log([...ticks(base, 3)].map((d) => d.getUTCSeconds()));
const held: unknown = base;
console.log((held as Date) === base, held instanceof Date, String(held) === String(base));
const bag: unknown = { at: base, list: dates };
console.log(JSON.stringify(bag));
console.log(JSON.stringify(events), JSON.stringify([base, new Date(NaN)]));
const byKey: { [k: string]: Date } = { boot: base };
console.log(byKey["boot"] === base, byKey["missing"], Object.keys(byKey));
