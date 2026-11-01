// Native records passed as `unknown` to helpers that read and write their
// keys, many times over: each crossing finds the record's capsule again, so
// writes through the untyped view and typed reads keep agreeing, and the
// same record keeps one identity across crossings.
type Counter = { hits: number; misses: number; name: string };

function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}

function read(target: unknown, key: string): unknown {
  return (target as Record<string, unknown>)[key];
}

// More records than the capsules kept between crossings, visited in turn.
const counters: Counter[] = [];
for (let i = 0; i < 40; i++) counters.push({ hits: 0, misses: 0, name: "c" + i });
let seed = 7;
for (let i = 0; i < 20000; i++) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  const c = counters[seed % 40]!;
  bump(c, (seed >>> 8) % 3 === 0 ? "misses" : "hits", 1);
  if (i % 97 === 0) c.hits += 10;
}
let hits = 0;
let misses = 0;
for (const c of counters) {
  hits += c.hits;
  misses += c.misses;
}
console.log(hits, misses, read(counters[3], "name"), read(counters[3], "hits") === counters[3]!.hits);

// One identity per record across separate crossings.
const seen = new Set<unknown>();
const tags = new WeakMap<object, string>();
function remember(value: unknown): void {
  seen.add(value);
  tags.set(value as object, "seen");
}
for (let round = 0; round < 3; round++) for (const c of counters) remember(c);
console.log(seen.size, tags.get(counters[0]!), tags.has(counters[39]!));
function same(a: unknown, b: unknown): boolean {
  return a === b;
}
console.log(same(counters[1], counters[1]), same(counters[1], counters[2]));

// A key the record does not declare, written through the view.
const extra: Counter = { hits: 1, misses: 2, name: "x" };
(extra as unknown as Record<string, unknown>).note = "added";
console.log(read(extra, "note"), JSON.stringify(extra), Object.keys(extra).join(","));

// Cyclic records crossing once each: they are collected while the program
// runs and at exit.
type Link = { id: number; next: Link | null };
let total = 0;
for (let i = 0; i < 5000; i++) {
  const a: Link = { id: i, next: null };
  const b: Link = { id: i + 1, next: a };
  a.next = b;
  total += read(a, "id") as number;
  bump(b, "id", 1);
  total += b.id;
}
console.log(total);
