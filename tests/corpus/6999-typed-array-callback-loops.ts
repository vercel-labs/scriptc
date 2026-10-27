// Typed-array callback methods with literal callbacks, function values shared
// by several calls, and callbacks chosen at run time: visit order and
// arguments, writes during the visit, early exits, reduce seeds and the
// empty-array TypeError, map conversions, Buffer results, throwing
// callbacks, empty arrays and subarray receivers.

const ints = new Int32Array([5, -3, 8, 0, 12, -7, 4]);
const floats = new Float32Array([0.1, 2.5, -1.25, 3.75, 9.5]);

const visits: string[] = [];
ints.forEach((v, i, a) => {
  visits.push(`${i}:${v}:${a === ints}`);
});
console.log("forEach", visits.join(" "));

const writes = new Uint8Array([1, 2, 3, 4, 5, 6]);
writes.forEach((v, i, a) => {
  if (i + 1 < a.length) a[i + 1] = a[i + 1]! + v;
});
console.log("forEach writes ahead", writes.join(","));

let calls = 0;
const counted = (v: number): boolean => {
  calls++;
  return v > 7;
};
console.log("some", ints.some(counted), calls);
calls = 0;
console.log("every", ints.every((v) => (calls++, v < 10)), calls);
calls = 0;
console.log("find", ints.find(counted), calls, ints.find((v) => v > 100));
calls = 0;
console.log("findIndex", ints.findIndex(counted), calls, ints.findIndex((v) => v > 100));

const order: number[] = [];
console.log(
  "findLast",
  ints.findLast((v, i) => (order.push(i), v < 0)),
  ints.findLastIndex((v) => v > 100),
  order.join(","),
);

console.log("reduce", ints.reduce((acc, v) => acc + v), ints.reduce((acc, v, i) => acc + v * i, 100));
const right: number[] = [];
console.log(
  "reduceRight",
  floats.reduceRight((acc, v, i) => (right.push(i), acc - v)),
  right.join(","),
  floats.reduceRight((acc, v) => acc + v, -1),
);
console.log("single", new Int8Array([42]).reduce(() => -1), new Int8Array([42]).reduceRight(() => -1));
function tryReduce(label: string, run: () => number): void {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, (error as Error).name, (error as Error).message);
  }
}
const emptyU16 = new Uint16Array(0);
const emptyF64 = new Float64Array(0);
tryReduce("empty u16 reduce", () => emptyU16.reduce((a, b) => a + b));
tryReduce("empty f64 reduceRight", () => emptyF64.reduceRight((a, b) => a + b));
tryReduce("empty with init", () => emptyU16.reduce((a, b) => a + b, 7) + emptyF64.reduceRight((a, b) => a + b, 1));
console.log("empty", emptyU16.some(() => true), emptyF64.every(() => false), emptyU16.map((v) => v).length);

console.log("map u8", new Uint8Array([250, 3, 128]).map((v) => v * 3).join(","));
console.log("map clamped", new Uint8ClampedArray([250, 3, 128]).map((v) => v * 1.5 - 10).join(","));
console.log("map i16", new Int16Array([30000, -30000, 7]).map((v, i) => v + i * 10000).join(","));
console.log("map f32", floats.map((v) => v / 3).join(","));
console.log("filter", ints.filter((v, i) => v > 0 && i % 2 === 0).join(","), floats.filter((v) => v > 1).join(","));

const buf = Buffer.from("scriptc");
const upper = buf.map((c) => c - 32);
console.log("buffer map", Buffer.isBuffer(upper), upper.join(","), Buffer.isBuffer(buf.filter((c) => c > 112)));

// One function value at several calls, and callbacks chosen at run time.
const double = (v: number): number => v * 2;
console.log("shared", new Int32Array([1, 2, 3]).map(double).join(","), new Int32Array([4, 5]).map(double).join(","));
const pick = (k: number): ((v: number) => boolean) => (k > 0 ? (v) => v > k : (v) => v < k);
console.log("chosen", ints.filter(pick(4)).join(","), ints.filter(pick(-4)).join(","));

try {
  let seen = 0;
  floats.forEach((v) => {
    seen++;
    if (v < 0) throw new RangeError(`negative ${v} after ${seen}`);
  });
} catch (error) {
  console.log("throw", (error as Error).name, (error as Error).message);
}

const view = ints.subarray(2, 5);
console.log("subarray", view.map((v) => v + 1).join(","), view.reduce((a, v) => a * 10 + v, 0), view.findLastIndex((v) => v === 8));
