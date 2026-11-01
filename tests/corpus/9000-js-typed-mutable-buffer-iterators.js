"use strict";
// The typed-array iterator factories, sort and toSorted validate their
// receiver first (t262-dc2): a detached view throws before the builtin reads
// %TypedArrayLength, even though the visit or the sort would do nothing.
const names = ["values", "keys", "entries"];
for (const name of names) {
  const view = new Uint8Array(4);
  view.buffer.transfer();
  try {
    const it = view[name]();
    console.log(name, "no throw", String(it.next().done));
  } catch (e) {
    console.log(name, e.constructor.name, e.message);
  }
}
const symbol = new Uint8Array(2);
symbol.buffer.transfer();
try {
  symbol[Symbol.iterator]();
  console.log("symbol no throw");
} catch (e) {
  console.log("symbol", e.constructor.name, e.message);
}
const loop = new Uint8Array(2);
loop.buffer.transfer();
try {
  for (const x of loop) console.log("forof", x);
} catch (e) {
  console.log("forof", e.constructor.name, e.message);
}
const sorted = new Float64Array([3, 1, 2]);
sorted.buffer.transfer();
try {
  sorted.sort();
  console.log("sort no throw");
} catch (e) {
  console.log("sort", e.constructor.name, e.message);
}
const copied = new Float64Array([3, 1, 2]);
copied.buffer.transfer();
try {
  copied.toSorted();
  console.log("toSorted no throw");
} catch (e) {
  console.log("toSorted", e.constructor.name, e.message);
}
// A shrink under a live iteration ends it at the live length.
const rab = new ArrayBuffer(4, { maxByteLength: 8 });
const shrunk = new Uint8Array(rab);
shrunk.set([7, 8, 9, 10]);
const seen = [];
for (const x of shrunk) {
  seen.push(x);
  if (seen.length === 1) rab.resize(2);
}
console.log("shrink", seen.join(","));
// The same builtins on live views still run.
console.log(new Uint8Array([3, 1, 2]).sort().join(","));
console.log(Array.from(new Uint8Array([4, 5])).join(","));
console.log(Array.from(new Uint8Array([4, 5]).keys()).join(","));
console.log(Array.from(new Uint8Array([6, 7]).values()).join(","));
console.log(Array.from(new Float64Array([2, 1, 3]).toSorted()).join(","));
