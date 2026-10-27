// Uint8ClampedArray stores: NaN and values at most 0 store 0, values at
// least 255 store 255, and values between round to the nearest integer,
// ties to even. Covers single stores and loops, every tie between 0 and
// 255 with the doubles on either side of it, and values far outside.

/** The largest power of two at most `x` (x > 0). */
function floorPower(x: number): number {
  let p = 1;
  while (p * 2 <= x) p *= 2;
  while (p > x) p /= 2;
  return p;
}

/** The doubles just above and below `x` (x >= 0). */
function nextUp(x: number): number {
  return x === 0 ? 5e-324 : x + floorPower(x) * 2 ** -52;
}

function nextDown(x: number): number {
  if (x === 0) return -5e-324;
  const p = floorPower(x);
  return x - (p === x ? p * 2 ** -53 : p * 2 ** -52);
}

function storeAll(values: Float64Array, out: Uint8ClampedArray): void {
  const n = out.length;
  for (let i = 0; i < n; i++) out[i] = values[i]!;
}

function scale(px: Uint8ClampedArray, k: number): void {
  const n = px.length;
  for (let i = 0; i < n; i++) px[i] = px[i]! * k;
}

const special = [
  NaN, -NaN, Infinity, -Infinity, 0, -0, 5e-324, -5e-324, 2.2250738585072014e-308, 0.49999999999999994,
  0.5, 0.5000000000000001, 1, 1.5, 2.5, 3.5, 127.5, 128.5, 253.5, 254.49999999999997, 254.5,
  254.50000000000003, 254.99999999999997, 255, 255.00000000000003, 255.5, 256, -1, -0.5, -0.4,
  1e300, -1e300, 2 ** 31, 2 ** 32 + 0.5, 2 ** 52, 2 ** 52 + 1, 2 ** 53, -(2 ** 52),
];
const one = new Uint8ClampedArray(1);
const singles: number[] = [];
for (const v of special) {
  one[0] = v;
  singles.push(one[0]!);
}
console.log("single", singles.join(","));

const ties: number[] = [];
for (let k = 0; k <= 255; k++) {
  ties.push(k + 0.5, nextDown(k + 0.5), nextUp(k + 0.5), k, nextDown(k), nextUp(k));
}
const values = new Float64Array(ties.length + special.length);
values.set(ties);
values.set(special, ties.length);
const stored = new Uint8ClampedArray(values.length);
storeAll(values, stored);
const expected = new Uint8ClampedArray(values.length);
for (let i = 0; i < values.length; i++) expected[i] = values[i]!;
let mismatches = 0;
for (let i = 0; i < values.length; i++) if (stored[i] !== expected[i]) mismatches++;
console.log("loop", values.length, "mismatches", mismatches);
let digest = 0;
for (let i = 0; i < stored.length; i++) digest = (Math.imul(digest, 31) + stored[i]!) | 0;
console.log("digest", digest, stored.subarray(0, 24).join(","));
console.log("tail", stored.subarray(ties.length).join(","));

const px = new Uint8ClampedArray(64);
for (let i = 0; i < px.length; i++) px[i] = i * 4.25;
scale(px, 1.37);
console.log("scaled", px.join(","));
scale(px, -1);
console.log("negated", px.join(","));
const fromInts = new Uint8ClampedArray(8);
const ints = new Int32Array([-300, -1, 0, 1, 254, 255, 256, 2147483647]);
for (let i = 0; i < fromInts.length; i++) fromInts[i] = ints[i]!;
console.log("ints", fromInts.join(","));
