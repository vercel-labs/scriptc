// A Set and a Map that hold a unit key, seen under another static type:
// an Iterable of the key type, a ReadonlySet / ReadonlyMap of the same
// key type, a generic function's parameter.
function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}

function readOnly(label: string, x: ReadonlySet<string | null>): void {
  console.log(label, x.size, x.has(null), x.has("a"));
  for (const v of x) console.log(label, show(v));
  console.log(label, [...x].map(show).join(","));
}

function readOnlyMap(label: string, x: ReadonlyMap<string | null, number>): void {
  console.log(label, x.size, x.has(null), x.get(null), x.get("a"));
  for (const k of x.keys()) console.log(label, show(k));
}

function generic<K>(label: string, x: ReadonlySet<K>, probe: K): void {
  console.log(label, x.size, x.has(probe));
  for (const v of x) console.log(label, show(v));
}

const s = new Set<string | null>(["a", null, "b"]);
const m = new Map<string | null, number>([
  ["a", 1],
  [null, 2],
]);
readOnly("readonly", s);
readOnlyMap("readonly-map", m);
generic("generic", s, null);
generic<string | null>("generic-b", s, "b");

const iter: Iterable<string | null> = s;
const seen: string[] = [];
for (const v of iter) seen.push(show(v));
console.log(seen.join(","));
const keyIter: Iterable<string | null> = m.keys();
for (const v of keyIter) console.log("key", show(v));
