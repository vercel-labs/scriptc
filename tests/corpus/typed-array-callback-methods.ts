// The typed-array callback methods: each callback receives the element, its
// index and the typed array; map and filter return the receiver's kind
// (map converts results like a store into it); the length is read once and
// each element when visited, so writes from the callback show later;
// reduce without an initial value throws on an empty typed array.
const f = new Float64Array([1, 2, 3.5]);
console.log(f.reduce((s, x) => s + x, 0), f.reduce((s, x) => s * x));
console.log(f.reduceRight((s, x) => `${s}${x};`, ""), f.reduceRight((a, b) => a - b));
const seen: string[] = [];
f.forEach((x, i, arr) => seen.push(`${i}:${x}:${arr.length}`));
console.log(seen.join(" "));
const doubled = f.map((x, i) => x * 2 + i);
console.log(doubled instanceof Float64Array, Array.from(doubled).join(","));
const bytes = new Uint8Array([10, 200, 30]);
const wrapped = bytes.map((x) => x + 100);
console.log(wrapped instanceof Uint8Array, Array.from(wrapped).join(","));
const clamped = new Uint8ClampedArray([1, 2]).map((x) => x * 300);
console.log(Array.from(clamped).join(","));
const kept = new Int16Array([-5, 4, -3, 2]).filter((x) => x > 0);
console.log(kept instanceof Int16Array, kept.length, Array.from(kept).join(","));
const ints = new Int32Array([3, 8, 1, 9]);
console.log(ints.some((x) => x > 8), ints.every((x) => x > 0), ints.every((x, i) => x > i * 3));
console.log(ints.find((x) => x > 5), ints.find((x) => x > 50), ints.findIndex((x) => x === 1));
console.log(ints.findLast((x) => x < 5), ints.findLastIndex((x) => x > 5), ints.findLastIndex((x) => x > 50));
const live = new Float32Array([1, 1, 1, 1]);
const sums = live.reduce((s, x, i, arr) => {
  if (i + 1 < arr.length) arr[i + 1] = x + 1;
  return s + x;
}, 0);
console.log(sums, Array.from(live).join(","));
try {
  new Float64Array(0).reduce((a, b) => a + b);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
console.log(new Float64Array(0).reduce((a, b) => a + b, 7));
