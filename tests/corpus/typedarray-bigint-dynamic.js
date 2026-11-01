// The BigInt typed-array kinds in the checked-dynamic tier: BigInt64Array and
// BigUint64Array have no typed element kind (no double holds 2^63), so a
// program that reads either constructor gets the JavaScript object model build
// (SCR_JS_OBJECT_MODEL) of the bytes units, where an element is a
// checked-dynamic BigInt. Elements read and
// write through ToBigInt, order and compare as BigInts, and the numeric view
// methods that walk values (map, filter, sort, join, ...) keep the element
// type; a numeric view and a BigInt view never convert into one another.
import { types, inspect } from "node:util";
import assert from "node:assert";

const report = (label, fn) => {
  try {
    console.log(label, fn());
  } catch (error) {
    console.log(label, error.name + ": " + error.message);
  }
};

const a = new BigInt64Array(3);
a[0] = 1n;
a[1] = -2n;
a[2] = 3n;
console.log(a.length, a.byteLength, a.BYTES_PER_ELEMENT, a.constructor.name, a instanceof BigInt64Array);
console.log(String(a), a.join("-"), a[0], a.at(-1), a.at(9), typeof a[1]);

// Writes are ToBigInt: a number never converts, and an out-of-range index is
// ignored after the conversion.
report("number write", () => {
  a[0] = 5;
  return a[0];
});
report("number fill", () => a.fill(5));
console.log(a.with(0, 9n).join(","), a.toReversed().join(","));

// Every construction form shares the generic path. (The constructor statics
// `from` and `of` stay fenced for every typed-array kind, numeric included.)
console.log(
  new BigUint64Array([1n, 2n]).join(","),
  new BigInt64Array(a).join(","),
  new BigInt64Array(a.buffer, 8, 2).join(","),
  new BigInt64Array(new BigUint64Array([7n])).join(","),
  new BigInt64Array(a.buffer.slice(8, 16)).join(","),
  new BigUint64Array(new ArrayBuffer(16)).join(","),
);
report("number element", () => new BigInt64Array([1]).length);
report("mixed set", () => {
  a.set(new Uint8Array(1));
  return a[0];
});
// A Buffer is a Uint8Array: it cannot read BigInt elements either.
report("buffer from", () => Buffer.from(new BigInt64Array([1n])).length);

// A function is an object for the constructor's Symbol.iterator lookup: a
// method the program put on it is read, so a present but non-callable one is
// the TypeError Node reports instead of an array-like read.
const errorName = (fn) => {
  try {
    fn();
    return "no throw";
  } catch (error) {
    return error.name;
  }
};
const carrying = function () {};
carrying[Symbol.iterator] = {};
console.log(errorName(() => new BigInt64Array(carrying)), errorName(() => new BigUint64Array(carrying)));
carrying[Symbol.iterator] = true;
console.log(errorName(() => new BigInt64Array(carrying)));
carrying[Symbol.iterator] = 42;
console.log(errorName(() => new BigUint64Array(carrying)));

// Value-walking methods keep BigInt elements.
const s = new BigInt64Array([3n, 1n, 2n]);
console.log(
  s.slice(1).join(","),
  s.map((x) => x * 2n).join(","),
  s.filter((x) => x > 1n).join(","),
  s.toSorted().join(","),
  s.sort((x, y) => (x < y ? 1 : -1)).join(","),
);
console.log(
  s.indexOf(2n),
  s.lastIndexOf(1n),
  s.includes(1n),
  s.indexOf(1),
  s.find((x) => x > 1n),
  s.findIndex((x) => x > 1n),
  s.reduce((x, y) => x + y, 0n),
  s.some((x) => x === 2n),
  s.every((x) => x > 0n),
);
console.log(new BigUint64Array([18446744073709551615n]).join(","), new BigInt64Array([-1n])[0]);

// The byte-level methods move the same 64-bit elements, and a second view of
// the buffer reads them back.
const c = new BigInt64Array([1n, 2n, 3n, 4n]);
console.log(
  c.copyWithin(0, 2).join(","),
  [...c.entries()].length,
  [...c.keys()].join(","),
  [...c.values()].join(","),
);
const d = new BigInt64Array(4);
d.set(new BigInt64Array([5n, 6n]), 1);
console.log(d.join(","), new BigInt64Array(d.buffer, 16).join(","), new DataView(c.buffer).byteLength);
console.log(c.reduceRight((x, y) => x - y), c.findLast((x) => x > 1n));
console.log(new BigInt64Array(3).fill(7n).join(","), new BigInt64Array([3n, 1n, 2n]).sort().join(","));
console.log(Object.entries(new BigUint64Array([7n]))[0].join(":"));

c.forEach((v, i, arr) => console.log("forEach", i, v, arr.length));
console.log(new BigInt64Array([7n, 8n]).slice(0, 1).buffer.byteLength);
report("with range", () => new BigInt64Array(3).with(-4, 1n).length);
// ToBigInt64 and ToBigUint64 wrap modulo 2^64 rather than clamping.
report("wrap", () => new BigUint64Array([-1n])[0] + " " + new BigInt64Array([18446744073709551615n])[0]);

// Iteration, reflection and inspection read the same elements.
console.log(String([...new BigUint64Array([1n, 2n])]), Object.values(new BigInt64Array([4n])).join(","));
console.log(Object.keys(s).length, Object.getOwnPropertyDescriptor(s, "1").value);
for (const value of new BigInt64Array([6n])) console.log(value);
report("json", () => JSON.stringify(s));
console.log(JSON.stringify(Array.from(s, (x) => String(x))), types.isBigInt64Array(a), types.isBigUint64Array(a));
console.log(new BigInt64Array([1234567n]).toLocaleString(), new BigInt64Array(2).subarray(1).length);
// util.inspect, console.table and assert formatting read the same elements.
console.log(inspect(new BigInt64Array([1n, -2n])));
console.table([{ v: new BigInt64Array([5n]) }]);
console.log(inspect({ a: new BigUint64Array([7n]), n: new Uint8Array([1]) }));
report("assert deep", () => {
  assert.deepStrictEqual(new BigInt64Array([1n]), new BigInt64Array([2n]));
  return "no throw";
});
report("assert ok", () => {
  assert.deepStrictEqual(new BigInt64Array([1n]), new BigInt64Array([1n]));
  return "ok";
});
// A numeric view in the same program keeps every numeric path.
console.log(new Uint8Array([1, 2]).join("+"), new Int16Array([3, 4]).join("-"), String(new Uint8Array([5, 6])));
const n = new Uint8Array([3, 1, 2]);
console.log(n.sort((x, y) => x - y).join(","), n.toReversed().join(","), n.fill(7).join(","));
