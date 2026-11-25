// @requires-libnode
// A Set and a Map that hold a unit key cross into a Node island (a package
// that requires a module named at run time) and come back.
import { describeSet, describeMap, hasNull, makeSet, makeMap, addNull, echo } from "islandsets";

function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}

const s = new Set<string | null>(["a", null, "b"]);
const m = new Map<string | null | undefined, number>();
m.set(null, 1);
m.set(undefined, 2);
m.set("k", 3);

console.log(describeSet(s));
console.log(describeMap(m));
console.log(hasNull(s), hasNull(new Set<string | null>(["only"])));

const made = makeSet();
console.log(made.size, made.has(null), made.has("made"));
console.log([...made].map(show).join(","));
const madeMap = makeMap();
console.log(madeMap.size, madeMap.get(null), madeMap.get(undefined), madeMap.get("made"));
console.log([...madeMap.keys()].map(show).join(","));

const plain = new Set<string | null>(["p"]);
addNull(plain);
console.log(plain.has(null), plain.size);
for (const v of plain) console.log("plain", show(v));

console.log(s.has(null), s.size, typeof echo);
