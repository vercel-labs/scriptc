// @requires-libnode
// A package only a Node island loads runs in that island's Node, so it is in
// the island set and its values are island values. `outer` is refused when
// the program loads (node:vm). `middle` and `leaf` compile natively on their
// own, and nothing but `outer` and `middle` loads them. The program uses
// only their interfaces, never a class of theirs: before containment that
// built without a note for either, and the first value under `Info` was
// checked into a native record and refused at run time ("expected object
// at $, got Object").
import { evaluate, leafOf, makeInfo, touch, type Info, type Leaf } from "outer";

const info: Info = makeInfo("first");
console.log("record", info.label, info.count, touch(info), info.count);

// The object stays the island's: a write on either side is seen by both.
info.count = 10;
console.log("written here", touch(info), info.count);

// Two levels down: `leaf` is loaded only by `middle`.
const leaf: Leaf = leafOf(info);
console.log("leaf", leaf.tag, leaf.sizes.length);
leaf.sizes.push(3);
console.log("same leaf", leafOf(info).sizes.join(","), leafOf(info) === leaf);

function total(items: Info[]): number {
  let sum = 0;
  for (const item of items) sum += item.count;
  return sum;
}
console.log("total", total([info, makeInfo("second")]));
console.log("outer still runs", evaluate("6 * 7"));
