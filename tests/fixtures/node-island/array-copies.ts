// Every use of a Node island's array of primitives that makes a native copy
// of it without the program saying so: one SC6007 warning each
// (tests/harness/node-island-array-copies.test.ts). The uses that stay the
// island's array, state the copy, or cannot observe it are the corpus
// program 8931-node-island-array-crossing, whose package this imports.
import { grid, holder, later, makeList, maybe, names } from "array-pkg";

function size(xs: number[]): number {
  return xs.length;
}

// An argument of a program function, directly and through a const.
size(makeList());
const list = makeList();
size(list);

// A binding that is not a const of the island's array.
let held = makeList();
var legacy: number[] = makeList();

// An assignment.
held = makeList();
const record: { xs: number[] } = { xs: [] };
record.xs = makeList();

// A return.
function get(): number[] {
  return makeList();
}
const arrow = (): string[] => names();

// A member of a native object, an element of a native array.
const boxed = { xs: makeList() };
class Keeper {
  xs: number[] = makeList();
}
const rows = [makeList()];

// A member of an island object read into a let.
let items = holder().items;

// The value an island promise settles with.
const awaited = await later();

// A native loop, over the call and over a const of it.
for (const x of makeList()) size([x]);
for (const x of list) size([x]);

// A value that flows on.
const fallback = maybe(false) ?? [];

// An array of arrays.
let nested: number[][] = grid();

// A standard function that can keep what it is given.
const kept: number[][] = [];
kept.push(makeList());

console.log(held, legacy, get(), arrow(), boxed, new Keeper(), rows, items, awaited, fallback);
console.log(nested, record, kept);
