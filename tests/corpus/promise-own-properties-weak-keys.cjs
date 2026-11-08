"use strict";
// A promise with own properties as a WeakMap and WeakSet key: the identity
// cell that keys the weak entries also holds the property table. The table
// is released with the last promise that points at the cell, while the weak
// collections may still hold the cell. The sanitized lane's RC audit reports
// a table that outlives its promises.
function untyped(value) {
  return value;
}
const map = new WeakMap();
const set = new WeakSet();
const kept = [];
for (let i = 0; i < 200; i++) {
  const p = untyped(Promise.resolve(i));
  p.status = "pending";
  p.index = i;
  map.set(p, "v" + i);
  set.add(p);
  if (i % 50 === 0) kept.push(p);
}
for (const p of kept) {
  console.log(p.index, p.status, map.get(p), set.has(p), Object.keys(p).join(","));
}
const late = untyped(Promise.resolve(7));
map.set(late, "late");
late.tag = "after";
console.log(map.get(late), late.tag, map.has(late));
map.delete(late);
console.log(map.has(late), late.tag);
