// @requires-libnode
// Cross-heap cycles through an island WeakMap (scope-B NI-8): a native key
// object maps to an island value that holds a native closure capturing the
// key. In Node the entry dies with the key; across the boundary the
// collector must honor the same ephemeron semantics, and keep the entries
// (and WeakRefs) of keys native code still holds.
import { requireModule } from "@scriptc/node";

const { churn, has, make, note, noteOf, read, watch, watchedAlive } = requireModule("./lib.cjs");

const kept = [];
let total = 0;
for (let i = 0; i < 4000; i++) {
  const key = { i, label: `k${i}` };
  const value = make(i);
  value.read = () => key.i + key.label.length;
  key.value = value;
  note(key, value);
  total += read(noteOf(key));
  if (i % 500 === 0) {
    kept.push(key);
    watch(key);
  }
  churn(4);
}
console.log("total", total);
console.log("kept entries", kept.filter((k) => has(k)).length, "of", kept.length);
console.log("kept values", kept.map((k) => read(noteOf(k))).join(","));
console.log("same value", kept.every((k) => noteOf(k) === k.value));
console.log("watched alive", watchedAlive(kept), "of", kept.length);
