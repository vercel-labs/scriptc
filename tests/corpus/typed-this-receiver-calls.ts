// Functions whose declared `this` has a static type, reached with the
// receiver bound: `f.call(receiver, ...)`, and forEach with a thisArg on a
// Set and a Map, then the forms that keep the call-time receiver (an
// array's forEach, a `.call` that omits an optional argument, rest
// parameters, a use as a value, a receiver of another type), which must
// behave the same.
type Tally = { label: string; total: number; items: string[] };

function add(this: Tally, amount: number, note: string): number {
  this.total += amount;
  this.items.push(note);
  return this.total;
}

function addEntry(this: Tally, value: number, key: string): void {
  this.total += value;
  this.items.push(key);
}

function addSetItem(this: Tally, value: string): void {
  this.items.push(value.toUpperCase());
}

function describe(this: Tally, suffix: string): string {
  return `${this.label}: ${this.total} [${this.items.join(",")}]${suffix}`;
}

const tally: Tally = { label: "tally", total: 0, items: [] };
console.log(add.call(tally, 2, "two"), add.call(tally, 5, "five"));
new Map([
  ["a", 1],
  ["b", 10],
]).forEach(addEntry, tally);
new Set(["x", "y"]).forEach(addSetItem, tally);
console.log(describe.call(tally, "!"));

function addNumber(this: Tally, value: number): void {
  this.total += value;
}
[100, 200].forEach(addNumber, tally);
console.log(tally.total);

function scaled(this: Tally, factor?: number): number {
  return this.total * (factor ?? 1);
}
console.log(scaled.call(tally), scaled.call(tally, 3));

function addAll(this: Tally, ...amounts: number[]): number {
  for (const amount of amounts) this.total += amount;
  return this.total;
}
console.log(addAll.call(tally, 5), addAll.call(tally, 1, 2));

// describe is also stored in a variable: called through it, it reads its
// receiver at the call.
const show = describe;
const other: Tally = { label: "other", total: 1, items: [] };
console.log(show.call(other, "?"));
console.log(describe.call(other, "."));

// A call that throws inside leaves the receiver's earlier writes in place.
function failAfter(this: Tally, limit: number): void {
  this.total += 1;
  if (this.total > limit) throw new Error(`${this.label} over ${limit}`);
}
try {
  failAfter.call(tally, 100);
  failAfter.call(tally, 0);
} catch (error) {
  console.log((error as Error).message, tally.total);
}

// A receiver of a wider type, or a class instance, is the object the
// function writes to, not a copy of the declared type.
type Counter = { count: number };
function bump(this: Counter, by: number): number {
  this.count += by;
  return this.count;
}
const wide = { count: 1, label: "wide" };
class Clicks {
  count = 10;
}
const clicks = new Clicks();
bump.call(wide, 2);
bump.call(clicks, 3);
new Set([4]).forEach(bump, clicks);
console.log(wide.count, clicks.count);
