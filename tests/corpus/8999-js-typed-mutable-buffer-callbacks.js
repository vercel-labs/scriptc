"use strict";
// Typed-array callback loops over a buffer that detaches or shrinks under
// them (t262-dc2). Node validates the receiver once (a detached or
// out-of-bounds view throws before the visit), captures %TypedArrayLength,
// and reads each element through the live view — so an index a shrink left
// out of view reads undefined and the callback still runs.
const methods = ["forEach", "map", "filter", "some", "every", "find", "findIndex",
  "findLast", "findLastIndex", "reduce", "reduceRight"];
for (const name of methods) {
  const view = new Uint8Array(4);
  view.buffer.transfer();
  try {
    const out = view[name](() => true);
    console.log(name, "no throw", String(out));
  } catch (e) {
    console.log(name, e.constructor.name, e.message);
  }
}
const seen = [];
const rab = new ArrayBuffer(4, { maxByteLength: 8 });
const src = new Uint8Array(rab);
src.set([1, 2, 3, 4]);
src.forEach((x, i) => {
  if (i === 0) rab.resize(2);
  seen.push(i + ":" + String(x));
});
console.log(seen.join(" "));
const kept = [];
const mapped = src.map((x, i) => {
  if (i === 0) rab.resize(1);
  kept.push(i + ":" + String(x));
  return x;
});
console.log(kept.join(" "));
console.log(mapped.constructor.name, mapped.length, mapped[0], mapped[1], mapped[2], mapped[3]);
const picked = new Uint8Array([0, 1, 2, 3]);
const visited = [];
const total = picked.reduce((acc, x, i) => {
  if (i === 0) picked.buffer.transfer();
  visited.push(i + ":" + String(x));
  return acc + (x === undefined ? 100 : x);
}, 0);
console.log(visited.join(" "), total);
const target = new Uint8Array(4);
target.buffer.transfer();
try {
  target.set([1, 2]);
} catch (e) {
  console.log("set", e.constructor.name, e.message);
}
const full = new Uint8Array([9, 8, 7]);
console.log(full.reduce((a, b) => a + b, 0), full.some((x) => x === 7), full.find((x) => x > 8));
