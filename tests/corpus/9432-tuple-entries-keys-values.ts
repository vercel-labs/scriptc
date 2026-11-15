// for-of over a fixed tuple's entries(), keys() and values(): the walk over
// its positions, each read when the walk reaches it, with the loop's own
// control flow and a fresh binding per iteration.
const sides: [string, string, string] = ["left", "top", "right"];
const fixed: readonly [number, number, number] = [4, 5, 6];
const lone: readonly [string] = ["north"];
const mixed: [string, number] = ["depth", 3];
const table = [
  ["oak", 3],
  ["elm", 5],
] as const;

for (const [i, side] of sides.entries()) console.log(i, side);
for (const [i, n] of fixed.entries()) console.log(i * n);
for (const [i, s] of lone.entries()) console.log(i, s);
for (const [i, v] of mixed.entries()) console.log(i, typeof v, v);
for (const [i, [name, count]] of table.entries()) console.log(i, name, count);
for (const entry of sides.entries()) console.log(entry[0], entry[1], entry.length);
for (const [i] of fixed.entries()) console.log("index", i);

for (const i of sides.keys()) console.log(i, sides[i]);
for (const side of sides.values()) console.log(side);
for (const n of fixed.values()) console.log(n + 1);

// break and continue.
let stopped = -1;
for (const [i, side] of sides.entries()) {
  if (side === "left") continue;
  for (const k of fixed.keys()) {
    if (k === 0) continue;
    if (k === 2) break;
    console.log(side, k);
  }
  if (side === "top") {
    stopped = i;
    break;
  }
}
console.log(stopped);

// Each iteration has its own bindings.
const later: (() => string)[] = [];
for (const [i, side] of sides.entries()) later.push(() => `${i}:${side}`);
console.log(later.map((f) => f()).join(","));

// A position is read when the walk reaches it.
const cells: [number, number, number] = [1, 2, 3];
for (const [i, n] of cells.entries()) {
  if (i === 0) cells[2] = 30;
  console.log(i, n);
}
for (const n of cells.values()) {
  if (n === 1) cells[1] = 20;
  console.log(n);
}
let first = true;
for (const i of cells.keys()) {
  if (first) cells[0] = 10;
  first = false;
  console.log(i, cells[i]);
}
