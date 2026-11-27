// A symbol a program adds to a SQLite object is one of its own keys: the
// descriptor record carries it beside the class's own symbol (the brand), so
// a copy made from Object.getOwnPropertyDescriptors keeps the value.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const marker = Symbol("marker");
db[marker] = "held";
db.plain = 2;
const descriptors = Object.getOwnPropertyDescriptors(db);
const copy = Object.defineProperties({}, descriptors);
console.log("copy", copy[marker], copy.plain);
console.log(
  "symbols",
  Object.getOwnPropertySymbols(descriptors).includes(marker),
  Object.getOwnPropertySymbols(db).includes(marker),
  Object.getOwnPropertySymbols(descriptors).length === Object.getOwnPropertySymbols(db).length,
);
const descriptor = Object.getOwnPropertyDescriptor(descriptors, marker).value;
console.log("descriptor", descriptor.value, descriptor.enumerable, descriptor.writable, descriptor.configurable);
db.close();
