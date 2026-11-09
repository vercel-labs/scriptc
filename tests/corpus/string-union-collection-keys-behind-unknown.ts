// A Set and a Map that hold a unit key, used only behind `unknown`:
// every read and write goes through the untyped view.
function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}

function probe(label: string, x: unknown): void {
  if (x instanceof Set) {
    console.log(label, "size", x.size, x.has(null), x.has(undefined), x.has("a"), x.has("zz"));
    for (const v of x) console.log(label, "of", show(v));
    x.forEach((v: unknown) => console.log(label, "forEach", show(v)));
    console.log(label, "spread", [...x].map(show).join(","));
    console.log(label, "from", Array.from(x).map(show).join(","));
    const values = x.values();
    console.log(label, "values", show(values.next().value), show(values.next().value));
    const keys = x.keys();
    console.log(label, "keys", show(keys.next().value));
    const entries = x.entries();
    const first: unknown = entries.next().value;
    console.log(label, "entries", Array.isArray(first) ? first.map(show).join("=") : "?");
    console.log(label, x);
  } else if (x instanceof Map) {
    console.log(label, "size", x.size, x.has(null), x.has(undefined), x.has("a"));
    console.log(label, "get", show(x.get(null)), show(x.get(undefined)), show(x.get("a")));
    for (const [k, v] of x) console.log(label, "of", show(k), show(v));
    x.forEach((v: unknown, k: unknown) => console.log(label, "forEach", show(k), show(v)));
    console.log(label, "keys", [...x.keys()].map(show).join(","));
    console.log(label, "from", Array.from(x.keys()).map(show).join(","));
    const keys = x.keys();
    console.log(label, "next", show(keys.next().value), show(keys.next().value));
    console.log(label, x);
  }
}

function mutate(x: unknown): void {
  if (x instanceof Set) {
    x.delete(null);
    x.add(undefined);
    x.add("late");
    x.add(null);
  } else if (x instanceof Map) {
    x.delete(null);
    x.set(undefined, 9);
    x.set(null, 8);
  }
}

const s = new Set<string | null | undefined>(["a", null, "b"]);
const m = new Map<string | null | undefined, number>([
  ["a", 1],
  [null, 2],
]);
probe("set", s);
probe("map", m);
mutate(s);
mutate(m);
probe("set2", s);
probe("map2", m);
console.log(s.has(null), s.has(undefined), s.has("late"), s.size);
console.log(m.get(null), m.get(undefined), m.get("a"), m.size);
for (const v of s) console.log("typed", show(v));
for (const [k, v] of m) console.log("typed", show(k), v);

const n = new Set<string | null>(["x", null]);
const o: unknown = n;
probe("nullable", o);
const fromDyn = o as Set<string | null>;
console.log(fromDyn.has(null), fromDyn.has("x"), fromDyn === n);
const holder: { inner: unknown } = { inner: new Map<string | undefined, string>([[undefined, "u"]]) };
probe("held", holder.inner);
