// A native WeakMap keyed by Node island objects whose entries the program
// ends itself, for node-island-weak-keys.test.ts: every iteration stores a
// native buffer of 256 KiB under a new island key and then deletes the
// entry or replaces its value. The buffers must go when their entries do,
// not when V8 next collects: the island holds nothing of them that would
// make it collect. Usage: weak-keys-values <n>
import { requireModule } from "@scriptc/node";

const lib = requireModule("./weak-keys.cjs");
const n = Number(process.argv[2] ?? "100");

const map = new WeakMap();
const keys = [];
let sum = 0;
for (let i = 0; i < n; i++) {
  const key = lib.make(i);
  keys.push(key);
  const buffer = new Uint8Array(256 * 1024).fill(i & 255);
  map.set(key, buffer);
  sum += map.get(lib.same(key))[1000];
  if (i % 2 === 0) {
    if (!map.delete(key)) throw new Error(`entry ${i} was not there to delete`);
  } else {
    map.set(key, i);
    if (map.get(key) !== i) throw new Error(`entry ${i} was not replaced`);
  }
}
let present = 0;
for (const key of keys) if (map.has(key)) present++;
console.log("sum", sum, "entries", present, "of", n);
console.error(`peak rss ${lib.maxRss()} KiB`);
