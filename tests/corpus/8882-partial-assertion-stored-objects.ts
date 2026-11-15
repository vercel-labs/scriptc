// A record or an array stored in a property that an asserted object literal
// did not write is that record or array, not a copy: the property and every
// other reference see each other's writes.
type Kind = "a" | "b" | "c";
type Groups = Record<Kind, number[]>;

const items: [Kind, number][] = [
  ["c", 1],
  ["a", 2],
  ["c", 3],
  ["b", 4],
];
const groups = {} as Groups;
for (const [kind, n] of items) {
  if (!(kind in groups)) groups[kind] = [];
  groups[kind].push(n);
}
console.log("groups", JSON.stringify(groups), groups.c.length, Object.keys(groups).join(","));

type Inner = { x: number; y: number };
type Outer = { inner: Inner; list: number[]; name: string; pair: [number, string] };
const outer = {} as Outer;
const inner: Inner = { x: 1, y: 2 };
const list: number[] = [];
const pair: [number, string] = [1, "one"];
outer.inner = inner;
outer.list = list;
outer.name = "n";
outer.pair = pair;
inner.x = 5;
outer.inner.y = 7;
list.push(1);
outer.list.push(2);
pair[0] = 2;
outer.pair[1] = "two";
console.log(
  "identity",
  outer.inner === inner,
  outer.inner === outer.inner,
  outer.list === list,
  outer.pair === pair,
);
console.log("values", inner.x, inner.y, list.join(","), pair.join(","), JSON.stringify(outer));

// An object filled in that holds another object filled in.
const nest = {} as Outer;
nest.inner = {} as Inner;
nest.inner.x = 1;
nest.inner.y = 2;
nest.list = [3];
nest.name = "nest";
nest.pair = [4, "four"];
const held = nest.inner;
held.x += 10;
console.log("nested", JSON.stringify(nest), nest.inner.x + nest.inner.y, held === nest.inner);

// A property replaced later holds the new object.
const replaced: Inner = { x: 8, y: 9 };
outer.inner = replaced;
replaced.y = 0;
console.log("replaced", outer.inner === replaced, outer.inner === inner, JSON.stringify(outer.inner), inner.y);

// A union property that holds a record or a string.
type Slot = { value: Inner | string; count: number };
const slot = {} as Slot;
slot.count = 1;
slot.value = inner;
const read = slot.value;
if (typeof read !== "string") read.x = 99;
console.log("union", inner.x, typeof slot.value);
slot.value = "text";
console.log("union", slot.value, JSON.stringify(slot));
