// Keyed reads and writes whose key is a union of literal names of declared
// fields stored with one type, on records whose other fields have other
// types: plain reads, plain writes, compound updates, keys from parameters
// and loops, and JavaScript evaluation order with effectful receivers and
// keys.
type Stats = { hits: number; misses: number; bytes: number; name: string; ok: boolean };
type Counter = "hits" | "misses" | "bytes";
type Flags = { name: string; verbose: boolean; strict: boolean; level: number };
type Labels = { id: number; title: string; summary: string; tags: string[] };

function read(s: Stats, key: Counter): number {
  return s[key];
}

function bump(s: Stats, key: Counter, by: number): void {
  s[key] = s[key] + by;
}

function toggle(flags: Flags, key: "verbose" | "strict"): boolean {
  flags[key] = !flags[key];
  return flags[key];
}

function relabel(labels: Labels, key: "title" | "summary", text: string): string {
  const before = labels[key];
  labels[key] = text.toUpperCase();
  return `${before} -> ${labels[key]}`;
}

const stats: Stats[] = [];
for (let i = 0; i < 4; i++) stats.push({ hits: 0, misses: 0, bytes: 0, name: "s" + i, ok: true });

let seed = 7;
for (let i = 0; i < 1000; i++) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  const s = stats[seed & 3]!;
  bump(s, seed % 5 === 0 ? "misses" : "hits", 1);
  bump(s, "bytes", (seed >>> 8) & 255);
}
for (const s of stats) console.log(s.name, read(s, "hits"), read(s, "misses"), read(s, "bytes"), s.ok);

// Keys from a loop over a constant list of names.
const counters = ["hits", "misses", "bytes"] as const;
const totals: Stats = { hits: 0, misses: 0, bytes: 0, name: "total", ok: false };
for (const s of stats) for (const key of counters) totals[key] += s[key];
console.log(totals.name, totals.hits, totals.misses, totals.bytes);

// Booleans and strings.
const flags: Flags = { name: "build", verbose: false, strict: true, level: 2 };
console.log(toggle(flags, "verbose"), toggle(flags, "strict"), toggle(flags, "verbose"), flags.level);
const labels: Labels = { id: 1, title: "draft", summary: "none", tags: ["a"] };
console.log(relabel(labels, "title", "final"), relabel(labels, "summary", "short"), labels.tags.length);

// The receiver, then the key, then the value, each once.
const order: string[] = [];
function pick(i: number): Stats {
  order.push("receiver " + i);
  return stats[i]!;
}
function name(key: Counter): Counter {
  order.push("key " + key);
  return key;
}
function amount(n: number): number {
  order.push("value " + n);
  return n;
}
pick(1)[name("misses")] = amount(40);
console.log(order.join(", "), stats[1]!.misses);
order.length = 0;
console.log(pick(2)[name("bytes")], order.join(", "));

// A key that names one field.
function only(s: Stats, key: "bytes"): number {
  s[key] = s[key] * 2;
  return s[key];
}
console.log(only(stats[3]!, "bytes"));

// A key or value that reassigns the receiver or key local: the write goes
// to the receiver and key evaluated before them.
let target = stats[0]!;
let slot: Counter = "hits";
target[slot] = ((slot = "misses"), 500);
console.log(stats[0]!.hits, stats[0]!.misses, slot);
target[slot] = ((target = stats[2]!), 600);
console.log(stats[0]!.misses, stats[2]!.misses, target === stats[2]);
function retarget(): Counter {
  target = stats[3]!;
  return "bytes";
}
target = stats[1]!;
target[retarget()] = 700;
console.log(stats[1]!.bytes, stats[3]!.bytes === 700);
target = stats[0]!;
slot = "hits";
target[slot] += ((slot = "bytes"), (target = stats[1]!), 1);
console.log(stats[0]!.hits, stats[0]!.bytes, stats[1]!.hits);
