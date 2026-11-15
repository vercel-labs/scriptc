// @requires-libnode
// What program code and island code see of each other's values, for the
// observations the island value-crossing matrix
// (tests/harness/island-value-matrix.test.ts) found answering differently
// from Node:
// - a program record inside the island answers the names every object
//   inherits from Object.prototype (String(v), hasOwnProperty, constructor);
// - `{ ...v }` and Object.assign copy an island object's own keys;
// - `v instanceof Array`, `Map`, `Date`, `RegExp` hold for an island value
//   the program types as `unknown`;
// - a missing key or index of an island object compares equal to undefined;
// - structuredClone of an island object typed `unknown` is Node's clone.
import {
  bare,
  date,
  describe,
  failure,
  inherited,
  isKept,
  keep,
  keptN,
  list,
  listValue,
  map,
  ownToString,
  pattern,
  record,
  table,
} from "value-pkg";

// 1. Inherited names of a program record, and of a class with its own
// toString, seen by the island.
interface Point {
  a: number;
  b: string;
}
const point: Point = { a: 1, b: "x" };
console.log("record:", inherited(point));
class Named {
  n = 7;
  toString(): string {
    return "Named(" + this.n + ")";
  }
}
console.log("class:", ownToString(new Named()));

// 2. Spreading and assigning an island object.
const rec = record();
console.log("spread:", Object.keys({ ...rec, z: 1 }).join(","));
console.log("assign:", Object.keys(Object.assign({ first: 0 }, rec)).join(","));

// 3. instanceof a standard class, for values the program received untyped.
function kinds(x: unknown): string {
  const out: string[] = [];
  if (x instanceof Array) out.push("Array");
  if (x instanceof Map) out.push("Map");
  if (x instanceof Date) out.push("Date");
  if (x instanceof RegExp) out.push("RegExp");
  if (x instanceof Error) out.push("Error");
  if (x instanceof RangeError) out.push("RangeError");
  if (x instanceof Object) out.push("Object");
  return out.join("+");
}
console.log("instanceof:", kinds(listValue()), kinds(map()), kinds(date()), kinds(pattern()));
console.log("instanceof:", kinds(failure()), kinds(rec), kinds([1]), kinds(new Map()), kinds(5));

// 4. A key or an index the island object does not have.
const codes = table();
console.log("key:", codes.a === undefined, codes.nope === undefined, codes["zz"] !== undefined);
console.log("key:", codes.nope == null, codes.a != null, null === codes.nope, undefined !== codes.a);
const items = list();
console.log("index:", items[0] === undefined, items[99] === undefined, items[99] !== undefined);
if (items[99] === undefined) console.log("index: absent");
else console.log("index: present");

// 5. structuredClone of an island object the program holds untyped: a
// fresh island object, detached from the one the island keeps.
const original = keep();
const copy = structuredClone(original);
console.log("clone:", copy === original, isKept(original), isKept(copy), describe(copy));
console.log("clone:", typeof structuredClone(bare()), keptN());
try {
  structuredClone(keep);
} catch (e) {
  console.log("clone:", e instanceof Error ? e.name : "?");
}
