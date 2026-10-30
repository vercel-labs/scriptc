// Weak collection keys that become unreachable leave the collection, and
// new objects allocated afterwards (which can reuse the freed storage) are
// not found in it: plain objects, arrays, class instances and functions,
// alongside many objects that were never keys.
class Point {
  constructor(x) {
    this.x = x;
  }
}
const map = new WeakMap();
const set = new WeakSet();
const kept = [];
function fill(round) {
  for (let i = 0; i < 200; i++) {
    const key = i % 4 === 0 ? { i } : i % 4 === 1 ? [i] : i % 4 === 2 ? new Point(i) : () => i;
    map.set(key, round * 1000 + i);
    set.add(key);
    if (i % 50 === 0) kept.push(key);
  }
}
let stale = 0;
let found = 0;
for (let round = 0; round < 20; round++) {
  fill(round);
  // Objects that were never keys, freed and reallocated in between.
  for (let i = 0; i < 500; i++) {
    const other = i % 2 ? { other: i } : new Point(-i);
    if (map.has(other) || set.has(other)) stale++;
  }
}
for (const key of kept) if (map.has(key) && set.has(key)) found++;
console.log(stale, found, kept.length, map.get(kept[0]), map.get(kept[kept.length - 1]));
