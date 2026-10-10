// Callees that append to arrays, build fresh arrays, bump an atomic id
// counter or read a module binding behind its import-cycle TDZ check remove
// no reference edge, so callers pass field projections borrowed. The values
// must stay intact even when the callee appends to the very array that owns
// a borrowed argument and moves its storage.
import { Holder, Item, makeHolder } from "./items.ts";
import { appendMany, compareLists, labelOf, shiftThenRead, snapshot, truncateThenRead } from "./compare.ts";

const h = makeHolder(3);
const filler = new Item("filler");
console.log(appendMany(h.list, h.list[0]!, 200, filler), h.list.length, h.list[0]!.name);
console.log(labelOf(h.first), labelOf(h.first), labelOf(h.list[5]!));
console.log(snapshot(h.list, h.first).map((i: Item) => i.name).join(","));

const other: Holder = makeHolder(3);
console.log(compareLists(h.short, other.short), compareLists(undefined, other.short), compareLists(h.short, undefined));
other.short = undefined;
console.log(compareLists(h.short, other.short), compareLists(other.short, other.short));

let sum = 0;
for (let i = 0; i < 300; i++) sum += appendMany(h.list, h.list[i % 7]!, 1, filler);
console.log(sum, h.list.length);

function removals(d: Holder): string {
  d.list[0] = new Item("only-in-list");
  const shifted = shiftThenRead(d.list, d.list[0]!);
  d.list[0] = new Item("truncated");
  const truncated = truncateThenRead(d.list, d.list[0]!);
  return `${shifted} ${truncated} ${d.list.length}`;
}
console.log(removals(makeHolder(2)));

// Loop bindings borrow their element while the loop body preserves edges:
// appending (and moving the storage) keeps them; removing them must not.
function grow(list: Item[], filler: Item): number {
  let total = 0;
  for (let i = 0; i < 6; i++) {
    const x = list[i]!;
    total += appendMany(list, x, 64, filler) + x.name.length;
  }
  return total;
}
function drain(list: Item[]): string {
  let out = "";
  for (const x of list) out += shiftThenRead(list, x) + ";";
  return out;
}
const g = makeHolder(6);
console.log(grow(g.list, filler), g.list.length);
const e = makeHolder(6);
console.log(drain(e.list), e.list.length);
