// Iterators of a Set and a Map that hold a unit key, handed on: to a
function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}
function drain(label: string, it: Iterator<string | null>): void {
  const out: string[] = [];
  for (let r = it.next(); !r.done; r = it.next()) out.push(show(r.value));
  console.log(label, out.join(","));
}
function drainUnknown(label: string, it: Iterable<unknown>): void {
  const out: string[] = [];
  for (const v of it) out.push(show(v));
  console.log(label, out.join(","));
}
function* pairs(m: Map<string | null, number>): Generator<[string | null, number]> {
  for (const e of m) yield e;
}

const s = new Set<string | null>(["a", null, "b"]);
const m = new Map<string | null, number>([
  ["a", 1],
  [null, 2],
]);

drain("values", s.values());
drain("keys", s.keys());
drain("mapkeys", m.keys());
drain("symbol", s[Symbol.iterator]());
drainUnknown("u-values", s.values());
drainUnknown("u-mapkeys", m.keys());
for (const [k, v] of pairs(m)) console.log("pair", show(k), v);

const entries = s.entries();
const first = entries.next();
if (!first.done) console.log("entry", show(first.value[0]), show(first.value[1]));
const second = entries.next();
if (!second.done) console.log("entry", show(second.value[0]), show(second.value[1]));
const mentries = m.entries();
mentries.next();
const e2 = mentries.next();
if (!e2.done) console.log("mentry", show(e2.value[0]), e2.value[1]);

const [h, n, ...rest] = s;
console.log("destructure", show(h), show(n), rest.length);
const [[k0], [k1, v1]] = m;
console.log("destructure map", show(k0), show(k1), v1);

console.log("some", s.values().some((v) => v === null), s.values().every((v) => v !== null));
console.log("from", Array.from(s.values()).map(show).join(","), Array.from(m.keys()).map(show).join(","));
console.log("spread", [...s.values()].map(show).join(","), [...m.keys()].map(show).join(","));
const kept: Iterator<string | null>[] = [s.values(), m.keys()];
for (const it of kept) console.log("kept", show(it.next().value), show(it.next().value));
const lazy = m.keys();
m.set("late", 3);
drain("live", lazy);
