// Native weak collections keyed by objects a Node island made, for
// node-island-weak-keys.test.ts. Each iteration makes an island object,
// enters it into a WeakMap, a WeakSet and a FinalizationRegistry, reads the
// entry back through a second crossing of the object, and drops it. The
// value is by turns a number, a native object, an island object that
// reaches the key, a native object that reaches the key and a native
// closure that captures the key: the last three are cycles through both
// heaps that end with the key. Some keys stay held by the program only,
// some by the island only (the program drops its handle and gets the
// object back at the end), and some dropped ones are watched by weak
// references inside the island. Usage: weak-keys <n> [gc[:<every>]] (gc:
// force a full V8 collection every 64 iterations; gc:<every>: every <every>).
import { requireModule } from "@scriptc/node";

const lib = requireModule("./weak-keys.cjs");
const n = Number(process.argv[2] ?? "1000");
const gcArg = process.argv[3] ?? "";
const gcEvery = gcArg === "gc" ? 64 : gcArg.startsWith("gc:") ? Number(gcArg.slice(3)) : 0;

const map = new WeakMap();
const set = new WeakSet();
const registry = new FinalizationRegistry(() => {});

function valueFor(key, i) {
  switch (i % 5) {
    case 0:
      return i;
    case 1:
      return { i };
    case 2:
      return lib.owner(key);
    case 3:
      return { key, i };
    default:
      return () => key.i;
  }
}
function read(value, i) {
  switch (i % 5) {
    case 0:
      return value;
    case 1:
      return value.i;
    case 2:
      return value.owns.i;
    case 3:
      return value.key.i;
    default:
      return value();
  }
}

const nativeKept = [];
let islandKept = 0;
let watched = 0;
let sum = 0;
for (let i = 0; i < n; i++) {
  const key = lib.make(i);
  const value = valueFor(key, i);
  // One entry in eleven replaces a native value.
  if (i % 11 === 5) map.set(key, { replaced: i });
  map.set(key, value);
  set.add(key);
  registry.register(key, i, key);
  const again = lib.same(key);
  const seen = map.get(again);
  if (seen !== value || !set.has(again)) throw new Error(`entry ${i} is not the one that was set`);
  sum += read(seen, i);
  // The same keys for every n of at least 2000, so what stays alive does
  // not grow with n.
  if (i < 2000) {
    if (i % 97 === 1) nativeKept.push(key);
    else if (i % 89 === 2) islandKept += lib.keep(key);
    else if (i % 7 === 3) {
      lib.watch(key);
      watched++;
    }
  }
  if (i % 7 === 6 && !map.delete(key)) throw new Error(`entry ${i} was not there to delete`);
  if (gcEvery > 0 && i % gcEvery === gcEvery - 1) lib.fullGc();
}
for (let round = 0; round < 12; round++) {
  lib.fullGc();
  await new Promise((resolve) => setTimeout(resolve, 1));
}

// Every kept key still has its entries, whichever side kept it.
let check = 0;
function verify(key) {
  const deleted = key.i % 7 === 6;
  if (map.has(key) === deleted || !set.has(key)) throw new Error(`entry ${key.i} was lost`);
  if (!deleted) check += read(map.get(key), key.i);
  if (!registry.unregister(key) || registry.unregister(key)) throw new Error(`token ${key.i} was lost`);
}
for (const key of nativeKept) verify(key);
const back = lib.keptKeys();
for (let k = 0; k < islandKept; k++) verify(back[k]);
console.log("sum", sum, "check", check, "kept", nativeKept.length, "and", islandKept);
console.log("dropped keys alive", lib.alive(), "of", watched);
console.error(`peak rss ${lib.maxRss()} KiB`);
