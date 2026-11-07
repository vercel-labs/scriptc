// @requires-libnode
// An array of primitives a Node island made is the island's own array
// wherever the program uses it through island operations, and a native
// array only where the program writes the copy. Every line below answers as
// Node does, and none of the uses is one that copies without saying so
// (those are SC6007 warnings: tests/harness/node-island-array-copies.test.ts).
import {
  grid,
  holder,
  keptJoin,
  later,
  makeList,
  maybe,
  names,
  pushKept,
  same,
  total,
} from "array-pkg";

// A const binding is the island's array: its members, its indices, its
// methods and its identity.
const list = makeList();
pushKept(4);
console.log("const sees the island's push:", list.length, list[3], list.join(","));
list.push(5);
console.log("the island sees the program's push:", keptJoin());
console.log("identity:", same(list), list[99] === undefined);
const count = (): number => list.length;
pushKept(6);
console.log("captured by a closure:", count(), total(list));

// A declared type on the const changes nothing.
const typed: number[] = makeList();
typed.push(7);
console.log("typed const:", typed.length, same(typed), keptJoin());

// An array read off an island object.
const box = holder();
const items = box.items;
pushKept(8);
console.log("member const:", items.length, same(items), box.items.length, box.name);

// Arrays of strings and arrays of arrays.
const words = names();
words.push("c");
console.log("strings:", words.includes("c"), words.indexOf("b"), words.map((w) => w + "!").join(""), keptJoin());
const rows = grid();
rows[0]!.push(9);
rows.push([3]);
console.log("nested:", rows.length, rows[0]!.length, rows[0]![1], same(rows), keptJoin());

// The copies the program writes: a new array under Node too.
const spread = [...makeList()];
const from = Array.from(makeList());
const sliced = makeList().slice();
const cloned = structuredClone(makeList());
pushKept(10);
spread.push(0);
from.push(0);
sliced.push(0);
cloned.push(0);
console.log("stated copies:", spread.length, from.length, sliced.length, cloned.length);
console.log("none is the island's:", same(spread), same(from), same(sliced), same(cloned), keptJoin());

// Reads that take every element at once.
function sum(...xs: number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}
const [first, second] = makeList();
console.log("at once:", first, second, sum(...makeList()), `${makeList()}`);
for (const x of [...makeList()]) {
  if (x === 1) pushKept(11);
  console.log("copied before the loop:", x);
}
console.log("after the loop:", keptJoin());

// Only whether the array is there.
const some = maybe(true);
const none = maybe(false);
console.log("presence:", some !== undefined, none === undefined, typeof some, !none, some ? "yes" : "no");
if (some !== undefined) {
  pushKept(12);
  console.log("narrowed:", some.length, same(some));
}

// An awaited array, copied where the program says so.
const awaited = [...(await later())];
pushKept(13);
console.log("awaited copy:", awaited.length, same(awaited), keptJoin());
