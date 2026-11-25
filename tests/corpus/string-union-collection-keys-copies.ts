// Copies of a Set and a Map that hold a unit key into collections of the
// same, a wider, a narrower and an untyped key type, and back.
function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}
function list<T>(label: string, x: Iterable<T>): void {
  const out: string[] = [];
  for (const v of x) out.push(show(v));
  console.log(label, out.join(","));
}

const s = new Set<string | null>(["a", null, "b"]);
const m = new Map<string | null, number>([
  ["a", 1],
  [null, 2],
]);

const same = new Set(s);
list("same", same);
console.log(same.has(null), same !== s);
const three = new Set<string | null | undefined>([...s]);
three.add(undefined);
list("three", three);
console.log(three.has(null), three.has(undefined));
const wide = new Set<string | number | null>();
for (const v of s) wide.add(v);
wide.add(7);
list("wide", wide);
console.log(wide.has(null), wide.has("a"), wide.has(7));
const dyn = new Set<unknown>(s);
list("dyn", dyn);
console.log(dyn.has(null), dyn.has("a"), dyn);

const back = new Set<string | null>();
for (const v of wide) if (typeof v !== "number") back.add(v);
list("back", back);
console.log(back.has(null));

const strings = new Set<string>(["p", "q"]);
const fromStrings = new Set<string | null>([...strings]);
fromStrings.add(null);
list("fromStrings", fromStrings);
const fromArray = new Set<string | undefined>(["x", undefined, "x", "y"]);
list("fromArray", fromArray);
const fromKeys = new Set<string | null>(m.keys());
list("fromKeys", fromKeys);
console.log(fromKeys.has(null));
const fromValues = new Set<string | null>(new Map<number, string | null>([[1, null], [2, "v"]]).values());
list("fromValues", fromValues);

const msame = new Map(m);
list("msame", msame.keys());
console.log(msame.get(null));
const mthree = new Map<string | null | undefined, number>([...m]);
mthree.set(undefined, 3);
list("mthree", mthree.keys());
console.log(mthree.get(null), mthree.get(undefined));
const mwide = new Map<string | number | null, number>();
for (const [k, v] of m) mwide.set(k, v);
mwide.set(5, 5);
list("mwide", mwide.keys());
console.log(mwide.get(null), mwide.get(5));
const mdyn = new Map<unknown, number>();
m.forEach((v, k) => mdyn.set(k, v));
list("mdyn", mdyn.keys());
console.log(mdyn.get(null), mdyn);
const mentries = new Map<string | null, number>([...m]);
list("mentries", mentries.keys());
const mfrom = new Map<string | null, number>(m.entries());
list("mfrom", mfrom.keys());
const mmapped = new Map<string | null, string>([...m].map(([k, v]): [string | null, string] => [k, String(v)]));
list("mmapped", mmapped.keys());
console.log(mmapped.get(null));

const arr: (string | null)[] = [...s];
const arr2 = Array.from(s);
const arr3 = Array.from(m.keys());
const arr4 = Array.from(s, (v) => (v === null ? "N" : v.toUpperCase()));
const arr5 = [...m.entries()];
list("arr", arr);
list("arr2", arr2);
list("arr3", arr3);
list("arr4", arr4);
console.log(arr5.length, arr5[1][0] === null, arr5[1][1]);
console.log(JSON.stringify(arr), JSON.stringify([...m]), JSON.stringify(Array.from(three)));
console.log(Object.fromEntries(m));
console.log(Object.keys(Object.fromEntries(m)).join(","));
