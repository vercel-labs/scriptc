// util.types brand checks over checked-dynamic values: Dates, Map and Set
// iterators (before and after they are consumed), SharedArrayBuffer and
// KeyObject carry their brands; arrays, plain objects and objects that
// imitate a Date or an iterator do not.
import { types } from "node:util";
import { createSecretKey } from "node:crypto";

const map = new Map([["a", 1]]);
const set = new Set([1, 2]);
const drained = set.values();
for (const _ of drained) {
  // drain
}
const values = [
  ["date", new Date(0)],
  ["map keys", map.keys()],
  ["map iterator", map[Symbol.iterator]()],
  ["set values", set.values()],
  ["drained set iterator", drained],
  ["array iterator", [1].values()],
  ["shared buffer", new SharedArrayBuffer(4)],
  ["key object", createSecretKey(Buffer.from("k"))],
  ["date-like", { getTime() { return 0; }, [Symbol.toStringTag]: "Date" }],
  ["iterator-like", { next() { return { done: true }; }, [Symbol.toStringTag]: "Map Iterator" }],
  ["array", [1, 2]],
  ["number", 1],
];
const probes = ["isDate", "isMapIterator", "isSetIterator", "isSharedArrayBuffer", "isKeyObject", "isBoxedPrimitive", "isNumberObject", "isBigInt64Array", "isExternal"];
for (const [label, value] of values) {
  console.log(label, probes.filter((name) => types[name](value)).join(",") || "-");
}
