/* The lane loop's differential fixture: the shapes the lane planner takes, and
 * the cases that pin the two rules the lowering leans on. tests/harness/
 * lane-loops.test.ts runs this under Node and as a compiled binary with the
 * run-time toggle on and off, and requires identical stdout.
 *
 * - Lengths that are a multiple of the vector width (4, 8, 16, 32, 64, 128,
 *   1024) with non-zero elements: the reduction must fold the lanes the loop
 *   accumulated after the last group, so a dropped group changes the sum.
 * - Lengths around the element count bound (2^21 for 32-bit elements): below
 *   it every partial sum is an exact double and the lane order matches Node's
 *   ascending order; at and above it the loop must take the scalar path and
 *   round exactly as Node does.
 * - Loops the planner must refuse: an accumulator the loop did not set to +0
 *   on every way in, and a receiver indexed through a union with more arms
 *   than the loop versioning pass splits.
 */

// Three arms each: the union arm loop pass (MAX_ARMS) splits these, so the
// loops inside them take one element type and the planner sees them.
type Eight = Uint8Array | Uint8ClampedArray | Int8Array;
type Sixteen = Uint16Array | Int16Array;
type ThirtyTwo = Uint32Array | Int32Array;
// Seven arms: no versioning, so these loops keep the per-element dispatch.
type Any =
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array;

function sum8(a: Eight): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function sum16(a: Sixteen): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function sum32(a: ThirtyTwo): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function sumAny(a: Any): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function sumReverse8(a: Eight): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t = a[i]! + t;
  return t;
}

function sumReverse32(a: ThirtyTwo): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t = a[i]! + t;
  return t;
}

function countGE8(a: Eight, limit: number): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! >= limit) c++;
  return c;
}

function countLT16(a: Sixteen, limit: number): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! < limit) c++;
  return c;
}

function countEQ32(a: ThirtyTwo, limit: number): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! === limit) c++;
  return c;
}

// The accumulator is set to +0 inside the outer loop, which is what the loop
// needs to be entered with; the lanes run on both passes.
function sumInner8(a: Eight): number {
  let total = 0;
  for (let k = 0; k < 2; k++) {
    let t = 0;
    for (let i = 0; i < a.length; i++) t += a[i]!;
    total += t;
  }
  return total;
}

// The accumulator outlives the loop it accumulates in, so the second pass
// starts from the first pass's value: the planner must refuse this loop.
function sumOuter32(a: ThirtyTwo): number {
  let t = 0;
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < a.length; i++) t += a[i]!;
  }
  return t;
}

// The accumulated value is not the declaration's +0 on every way in.
function sumAfterWrite32(a: ThirtyTwo, seed: number): number {
  let t = 0;
  if (seed > 0) t = seed;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

// A switch case falls into the one after it, so the case ahead of the loop
// can leave the accumulator away from +0: the planner must refuse this loop.
// `sumSwitchClean32` has the same shape with a quiet case first, so the
// lowering really does plan loops written inside a switch case.
function sumSwitchHuge32(a: ThirtyTwo, tag: number): number {
  let t = 0;
  switch (tag) {
    case 0:
      t = 9007199254740992;
    case 1:
      for (let i = 0; i < a.length; i++) t += a[i]!;
      break;
  }
  return t;
}

function sumSwitchClean32(a: ThirtyTwo, tag: number): number {
  let t = 0;
  let seen = 0;
  switch (tag) {
    case 0:
      seen = 1;
    case 1:
      for (let i = 0; i < a.length; i++) t += a[i]!;
      break;
  }
  return t + seen;
}

// The count's limit is evaluated once at the lane entry, so the counter and
// the accumulator cannot be one: both change every iteration, and freezing
// either at its starting value would count a different number of elements.
function countAgainstIndex32(a: ThirtyTwo): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! >= i) c++;
  return c;
}

function countAgainstCount32(a: ThirtyTwo): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! >= c) c++;
  return c;
}

function ones32(n: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = 1;
  return a;
}

function raw(i: number, n: number, pattern: number): number {
  if (pattern === 0) return (i * 37 + n * 101 + 11) & 0xff;
  if (pattern === 1) return i % 7;
  if (pattern === 2) return 255;
  if (pattern === 3) return -128;
  return i === n - 1 ? 1 : 0;
}

function make8(n: number, pattern: number): Uint8Array {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern);
  return a;
}

function make8c(n: number, pattern: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern) * 2;
  return a;
}

function makei8(n: number, pattern: number): Int8Array {
  const a = new Int8Array(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern) - 3;
  return a;
}

function make16(n: number, pattern: number): Uint16Array {
  const a = new Uint16Array(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern) * 257;
  return a;
}

function makei16(n: number, pattern: number): Int16Array {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern) * 129 - 20000;
  return a;
}

function make32(n: number, pattern: number): Uint32Array {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern) * 16843009;
  return a;
}

function makei32(n: number, pattern: number): Int32Array {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = raw(i, n, pattern) * 16843009 - 70000;
  return a;
}

const lengths = [
  0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 1023, 1024,
  1025,
];
const limits = [0, 1, 3, 127, 128, 255, 256, -1, -129, 32767, 32768, 65535, 65536, 2.5, -0.5, 1e300];

function run8(kind: number, n: number, pattern: number, a: Eight): void {
  console.log("eight", kind, n, pattern, sum8(a), sumReverse8(a), sumInner8(a), sumAny(a));
  for (const limit of limits) console.log("c", kind, n, pattern, limit, countGE8(a, limit));
}

function run16(kind: number, n: number, pattern: number, a: Sixteen): void {
  console.log("sixteen", kind, n, pattern, sum16(a), sumAny(a));
  for (const limit of limits) console.log("c", kind, n, pattern, limit, countLT16(a, limit));
}

function run32(kind: number, n: number, pattern: number, a: ThirtyTwo): void {
  console.log(
    "thirtytwo",
    kind,
    n,
    pattern,
    sum32(a),
    sumReverse32(a),
    sumOuter32(a),
    sumAfterWrite32(a, 7),
    sumAny(a),
  );
  for (const limit of limits) console.log("c", kind, n, pattern, limit, countEQ32(a, limit));
}

for (const n of lengths) {
  for (let pattern = 0; pattern < 5; pattern++) {
    run8(0, n, pattern, make8(n, pattern));
    run8(1, n, pattern, make8c(n, pattern));
    run8(2, n, pattern, makei8(n, pattern));
    run16(3, n, pattern, make16(n, pattern));
    run16(4, n, pattern, makei16(n, pattern));
    run32(5, n, pattern, make32(n, pattern));
    run32(6, n, pattern, makei32(n, pattern));
  }
}

// The element count bound, from both sides.
for (const n of [2097148, 2097151, 2097152, 2097156, 2098152, 4195304]) {
  const a = make32(n, 2);
  const b = makei32(n, 2);
  console.log("big", n, sum32(a), sumReverse32(a), sum32(b), sumReverse32(b));
}

// A switch's earlier case, and the element test's own values: both must print
// what Node prints, with the lane loops the lowering keeps for the quiet case
// and without them where the planner refuses.
for (const n of [0, 1, 3, 4, 5, 8, 17]) {
  const ones = ones32(n);
  for (const tag of [0, 1, 2])
    console.log("switch", n, tag, sumSwitchHuge32(ones, tag), sumSwitchClean32(ones, tag));
  console.log("counts", n, countAgainstIndex32(ones), countAgainstCount32(ones));
}
