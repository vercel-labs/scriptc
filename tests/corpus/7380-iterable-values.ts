// Iterable<T> values: an array, Set, Map or string stays the same object
// (multi-pass, same identity, same inspection), and a generator or a
// Map/Set/array iterator stays single-pass. for-of, spread, Array.from and
// the Set/Map constructors consume every source.

function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function* nums(): Generator<number, void, undefined> {
  yield 10;
  yield 20;
}

const arr = [1, 2, 3];
const scores = new Map<string, number>([
  ["a", 4],
  ["b", 5],
]);
console.log(sum(arr), sum(new Set([1, 1, 2])), sum(scores.values()), sum(nums()), sum(arr.values()));

// An array stays the same multi-pass object.
const it: Iterable<number> = arr;
console.log(sum(it), sum(it), it === arr, typeof it, it);

// A generator stays single-pass.
const once: Iterable<number> = nums();
console.log(sum(once), sum(once), typeof once);

console.log([...it], Array.from(nums() as Iterable<number>), new Set(it).size);

// A function returning either a collection iterator or a fresh array.
function pick(rows: Map<string, number>, ids: string[] | null): Iterable<number> {
  if (ids === null) return rows.values();
  const out: number[] = [];
  for (const id of ids) out.push(rows.get(id) ?? 0);
  return out;
}
let total = 0;
for (const v of pick(scores, null)) total += v;
for (const v of pick(scores, ["b", "b", "z"])) total += v;
console.log(total);

// Strings iterate by code point; Maps iterate [key, value] entries.
function upper(s: Iterable<string>): string[] {
  const out: string[] = [];
  for (const w of s) out.push(w.toUpperCase());
  return out;
}
console.log(upper("héllo😀"), upper(["a", "b"]), upper(new Set(["x"])));
function pairs(p: Iterable<[string, number]>): string {
  let out = "";
  for (const [k, v] of p) out += `${k}=${v};`;
  return out;
}
console.log(pairs(scores), pairs([["x", 1]]), pairs(scores.entries()), pairs(new Set<[string, number]>([["s", 9]])));

// Constructors and Object.fromEntries take any Iterable.
function toMap(p: Iterable<[string, number]>): Map<string, number> {
  return new Map(p);
}
function toSet(xs: Iterable<number>): Set<number> {
  return new Set(xs);
}
console.log(toMap([["a", 1], ["b", 2]]), toMap(scores), Object.fromEntries(toMap(new Set<[string, number]>([["c", 3]]))));
console.log(toSet([3, 3, 4]), toSet(new Set([9])), toSet(nums()));

// Fields, generator functions declared to return Iterable, nested Iterables.
class Holder {
  source: Iterable<string>;
  constructor(source: Iterable<string>) {
    this.source = source;
  }
  joined(): string {
    let out = "";
    for (const s of this.source) out += s;
    return out;
  }
}
const holder = new Holder(["a", "b"]);
console.log(holder.joined(), holder.joined());
holder.source = new Set(["x", "y"]);
console.log(holder.joined(), holder);

function* range(n: number): Iterable<number> {
  for (let i = 0; i < n; i++) yield i;
}
console.log([...range(4)], sum(range(5)));

const grid: Iterable<number>[] = [[1, 2], new Set([3]), range(3)];
let cells = 0;
for (const row of grid) for (const c of row) cells += c;
console.log(cells, grid.length);

// A checked cast of an iterator value.
const entries = new Map([["k", 1]]).entries() as Iterable<[string, number]>;
console.log(toMap(entries));

// Optional Iterables narrow to the Iterable once proven present.
function totalOf(xs?: Iterable<number>): number {
  if (xs === undefined) return -1;
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
function orEmpty(xs: Iterable<number> | null): number[] {
  return xs === null ? [] : [...xs];
}
console.log(totalOf(), totalOf([1, 2]), totalOf(new Set([5])), orEmpty(null), orEmpty(range(2)));
const byName = new Map<string, Iterable<number>>([
  ["a", [1, 2]],
  ["b", new Set([3])],
]);
for (const k of ["a", "b", "c"]) {
  const got = byName.get(k);
  if (got !== undefined) console.log(k, [...got]);
  else console.log(k, "none");
}
const top = byName.get("a");
console.log(top !== undefined ? [...top] : "none", byName);
