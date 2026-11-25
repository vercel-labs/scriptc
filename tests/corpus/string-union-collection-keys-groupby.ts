// Map.groupBy with a key callback that returns a string or a unit value.
interface Item {
  name: string;
  owner: string | null;
  tag?: string;
}
const items: Item[] = [
  { name: "a", owner: "x", tag: "t" },
  { name: "b", owner: null },
  { name: "c", owner: "x" },
  { name: "d", owner: null, tag: "t" },
];

const byOwner = Map.groupBy(items, (item) => item.owner);
console.log(byOwner.size, byOwner.has(null), byOwner.has("x"));
console.log(byOwner.get(null)!.map((i) => i.name).join(","), byOwner.get("x")!.map((i) => i.name).join(","));
for (const [k, v] of byOwner) console.log(k === null ? "<null>" : k, v.length);
console.log([...byOwner.keys()].map((k) => (k === null ? "<null>" : k)).join(","));
console.log(byOwner);

const byTag = Map.groupBy(items, (item) => item.tag);
console.log(byTag.size, byTag.has(undefined), byTag.get(undefined)!.length, byTag.get("t")!.length);
for (const k of byTag.keys()) console.log(k === undefined ? "<undefined>" : k);
console.log(byTag);

const owners = new Set<string | null>(items.map((i) => i.owner));
const fromSet = Map.groupBy(owners, (o) => (o === null ? null : o.toUpperCase()));
console.log(fromSet.size, fromSet.has(null), fromSet.get(null), fromSet.get("X"));

const grouped = Object.groupBy(items, (item) => item.owner ?? "none");
console.log(Object.keys(grouped).join(","));
