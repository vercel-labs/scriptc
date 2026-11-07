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

/* Store loops: an elementwise write the lane store lowers. Every one writes
 * the array it reads, so a wrong vector width, a dropped group or a wrong
 * store conversion changes what the program prints. The entry tests (the
 * element count, and the magnitude of an element's multiplier) are exercised
 * from both sides by the values the drivers pass. */

type Floats = Float64Array | Float32Array;

function fill32(a: ThirtyTwo, v: number): void {
  for (let i = 0; i < a.length; i++) a[i] = v;
}

function scale32(a: ThirtyTwo, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function bump8(a: Eight, add: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! + add;
}

function drop8(a: Eight, add: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! - add;
}

function ramp16(a: Sixteen, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = i * k;
}

function index16(a: Sixteen, base: number): void {
  for (let i = 0; i < a.length; i++) a[i] = i + base;
}

function back16(a: Sixteen, base: number): void {
  for (let i = 0; i < a.length; i++) a[i] = base - i;
}

function clampScale(a: Uint8ClampedArray, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function fillF(a: Floats, v: number): void {
  for (let i = 0; i < a.length; i++) a[i] = v;
}

function scaleF(a: Floats, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function offsetF(a: Floats, add: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! - add;
}

// Literal forms: these take the integer route, where the stored integer is
// the exact value below the element count's bound and the lane body multiplies
// or adds without converting to double.
function rampLit16(a: Sixteen): void {
  for (let i = 0; i < a.length; i++) a[i] = i * 3;
}

function shiftLit8(a: Eight): void {
  for (let i = 0; i < a.length; i++) a[i] = i + 70000;
}

function backLit16(a: Sixteen): void {
  for (let i = 0; i < a.length; i++) a[i] = 70000 - i;
}

function fillLit32(a: ThirtyTwo): void {
  for (let i = 0; i < a.length; i++) a[i] = -7;
}

// Exact integer lanes from a value the loop does not change: the lanes
// multiply the exact integers, while above 2^53 the scalar body stores the low
// bits of the double it rounds to, so a product that can pass 2^53 keeps its
// scalar body and the lanes run only below the entry bound. `rampK32`
// multiplies the counter instead, where the bound is the array's length times
// the factor.
function squareK32(a: ThirtyTwo, n: number): void {
  const k = n | 0;
  for (let i = 0; i < a.length; i++) a[i] = k * k;
}

function rampK32(a: ThirtyTwo, n: number): void {
  const k = n | 0;
  for (let i = 0; i < a.length; i++) a[i] = i * k;
}

// The magnitude test: an element times a literal above the bound an element's
// product may keep must be taken by the loop's scalar body, which converts
// the double itself.
function wideScale8(a: Eight): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * 1e15;
}

function narrowScale8(a: Eight): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * 3;
}

// A fractional literal is not an exact integer, so the value keeps the double
// route and its lanes convert directly, under the entry bound on the value's
// magnitude.
function fracScale8(a: Eight): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * 2.5;
}

// Shapes the planner must refuse, kept scalar: the element and the counter in
// one operation, a division, and a second element read.
function mix16(a: Sixteen): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * i;
}

function ratio32(a: ThirtyTwo, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! / k;
}

function pair16(a: Sixteen, b: Sixteen): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! - b[i]!;
}

/** Each float element's sign as a reciprocal, so a stored -0 is visible
 * where `join` would print it as 0. */
function signs(a: Floats): string {
  let s = "";
  for (let i = 0; i < a.length; i++) {
    const one = 1 / a[i]!;
    s = i === 0 ? "" + one : s + " " + one;
  }
  return s;
}

/* Dense number arrays. A sum or count lanes the array's int32 slots and a
 * store lanes its double slots; both test the storage kind and that every
 * slot below the length holds a value when the loop is entered, so a
 * double-stored, holed or mixed array takes the scalar loop, which is what
 * Node's semantics need. */

function denseSum(a: number[]): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += a[i]!;
  return t;
}

function denseSumReverse(a: number[]): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t = a[i]! + t;
  return t;
}

// The count stays in an int32 slot, so its loop is the integer copy's.
function denseCountBelow(a: number[]): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! < 3) c++;
  return c;
}

// A non-integer write after the loop keeps the count in a double slot, which
// is the slot the lane body folds into.
function denseCountRoot(a: number[]): number {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (a[i]! < 3) c++;
  c = Math.sqrt(c);
  return c;
}

function denseZero(a: number[]): void {
  for (let i = 0; i < a.length; i++) a[i] = 0;
}

function denseFill(a: number[], v: number): void {
  for (let i = 0; i < a.length; i++) a[i] = v;
}

function denseScale(a: number[], k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k;
}

function denseShift(a: number[], add: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! + add;
}

function denseRamp(a: number[]): void {
  for (let i = 0; i < a.length; i++) a[i] = i * 3;
}

// A division cannot be reordered onto lanes.
function denseHalve(a: number[], k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! / k;
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

function makeF64(n: number, pattern: number): Float64Array {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (pattern === 0) a[i] = (i - 2) * 1.5;
    else if (pattern === 1) a[i] = i === 0 ? -0 : 1 / i;
    else if (pattern === 2) a[i] = i % 3 === 0 ? NaN : i;
    else if (pattern === 3) a[i] = i % 2 === 0 ? Infinity : -Infinity;
    else a[i] = (i * 1e300) / 3;
  }
  return a;
}

function makeF32(n: number, pattern: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (pattern === 0) a[i] = (i - 2) * 0.25;
    else if (pattern === 1) a[i] = i === 0 ? -0 : 1 / i;
    else if (pattern === 2) a[i] = i % 3 === 0 ? NaN : i * 3;
    else if (pattern === 3) a[i] = i % 2 === 0 ? Infinity : -Infinity;
    else a[i] = (i * 1e30) / 7;
  }
  return a;
}

function denseMake(n: number, pattern: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) {
    if (pattern === 0) a[i] = i - 2;
    else if (pattern === 1) a[i] = (i * 37 + 11) % 97;
    else if (pattern === 2) a[i] = i === 0 ? -0 : i * 1.5;
    else if (pattern === 3) a[i] = i % 5 === 0 ? NaN : i;
    else if (pattern === 4) a[i] = i * 1e300;
    else a[i] = i === n - 1 ? 1 : 0;
  }
  return a;
}

/** An array with holes: filling fewer slots than its length leaves the
 * entries the lane entry test has to see. Reading one traps as the scalar
 * access does, so only the store loops take a sparse array here. */
function denseSparse(n: number, step: number): number[] {
  const a: number[] = new Array(n);
  for (let i = 0; i < n; i++) if (i % step !== 0) a[i] = i;
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

const denseLengths = [0, 1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 63];
const denseFactors = [0, 1, 2, -1, 0.5, 2.5, 1e15, NaN, Infinity];
const denseFills = [0, -0, 1, -1, 255, 1e300, NaN, Infinity, 0.49999999999999994];

for (const n of denseLengths) {
  for (let p = 0; p < 6; p++) {
    const a = denseMake(n, p);
    console.log(
      "dense",
      n,
      p,
      denseSum(a),
      denseSumReverse(a),
      denseCountBelow(a),
      denseCountRoot(a),
    );
    for (let j = 0; j < denseFactors.length; j++) {
      const k = denseFactors[j]!;
      const b = denseMake(n, p);
      denseScale(b, k);
      console.log("densescale", n, p, j, b.join(" "));
      const c = denseMake(n, p);
      denseShift(c, k);
      console.log("denseshift", n, p, j, c.join(" "));
      const d = denseMake(n, p);
      denseHalve(d, k);
      console.log("densehalve", n, p, j, d.join(" "));
    }
    for (let j = 0; j < denseFills.length; j++) {
      const f = denseMake(n, p);
      denseFill(f, denseFills[j]!);
      console.log("densefill", n, p, j, f.join(" "));
    }
    const r = denseMake(n, p);
    denseRamp(r);
    console.log("denseramp", n, p, r.join(" "));
    const z = denseMake(n, p);
    denseZero(z);
    console.log("densezero", n, p, z.join(" "));
  }
  // A sparse array's fill writes every slot: the lane entry test sees the
  // holes in it and leaves the loop to the scalar body.
  const s = denseSparse(n, 3);
  denseFill(s, 4);
  console.log("densefilled", n, s.join(" "));
  const u = denseSparse(n, 4);
  denseRamp(u);
  console.log("denserampholes", n, u.join(" "));
}

// The dense sum's element count bound, from both sides, with elements at the
// top of the int32 range: below it the lane order's partial sums are exact
// doubles, at it the loop takes the scalar path.
for (const n of [4194300, 4194304]) {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a[i] = i % 2 === 0 ? 2147483647 : 2147483646;
  console.log("densebig", n, denseSum(a), denseSumReverse(a));
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

// Store loops, from both sides of the element count's vector width and of
// each entry test: multipliers below and above the magnitude bound an
// element's product may keep, and values that convert through ToUint32,
// ToUint8Clamp or the float narrowing. Lengths include the exact multiples of
// four and their neighbours.
const storeLengths = [0, 1, 3, 4, 5, 8, 9, 17];
const storeFactors = [
  0, 1, 2, -1, 0.5, -0.5, 2.5, 1e15, -1e15, 9007199254740992, NaN, Infinity,
];
const storeFills = [0, -0, 1, -1, 255, 256, -128.5, 1e300, NaN, Infinity, -Infinity, 0.49999999999999994];
const storeBases = [0, 1, -1, 3, 255, 256, -129, 65535, 1e10, 9007199254740992, NaN];
// Integer factors around the points where a product leaves exact integers:
// 46341 squared passes int32, 134217729 squared passes 2^53, and the counter
// times the largest int32 stays a double for every length here.
const storeInts = [
  0, 1, 3, -3, 46340, 46341, 65536, -65536, 134217729, -134217729, 2147483647, -2147483648,
];

for (const n of storeLengths) {
  for (let j = 0; j < storeFactors.length; j++) {
    const k = storeFactors[j]!;
    const w = make32(n, j % 5);
    scale32(w, k);
    console.log("scale32", n, j, w.join(" "));
    const mi = makei32(n, j % 5);
    scale32(mi, k);
    console.log("scalei32", n, j, mi.join(" "));
    const b = make8(n, j % 5);
    bump8(b, k);
    console.log("bump8", n, j, b.join(" "));
    const c = make8(n, (j + 1) % 5);
    drop8(c, k);
    console.log("drop8", n, j, c.join(" "));
    const cl = make8c(n, j % 5);
    clampScale(cl, k);
    console.log("clamp", n, j, cl.join(" "));
    const f = makeF64(n, j % 5);
    scaleF(f, k);
    console.log("scalef64", n, j, f.join(" "), signs(f));
    const g = makeF32(n, j % 5);
    scaleF(g, k);
    console.log("scalef32", n, j, g.join(" "), signs(g));
    const h = makeF64(n, j % 5);
    offsetF(h, k);
    console.log("offsetf64", n, j, h.join(" "), signs(h));
    const r = make32(n, j % 5);
    ratio32(r, k);
    console.log("ratio", n, j, r.join(" "));
    const s8 = make8(n, j % 5);
    wideScale8(s8);
    console.log("wide8", n, j, s8.join(" "));
    const n8 = make8(n, (j + 2) % 5);
    narrowScale8(n8);
    console.log("narrow8", n, j, n8.join(" "));
    const f8 = make8(n, (j + 3) % 5);
    fracScale8(f8);
    console.log("frac8", n, j, f8.join(" "));
  }
  for (let j = 0; j < storeFills.length; j++) {
    const v = storeFills[j]!;
    const w = make32(n, j % 5);
    fill32(w, v);
    console.log("fill32", n, j, w.join(" "));
    const mi = makei32(n, j % 5);
    fill32(mi, v);
    console.log("filli32", n, j, mi.join(" "));
    const f = makeF64(n, j % 5);
    fillF(f, v);
    console.log("fillf64", n, j, f.join(" "), signs(f));
    const g = makeF32(n, j % 5);
    fillF(g, v);
    console.log("fillf32", n, j, g.join(" "), signs(g));
  }
  for (let j = 0; j < storeBases.length; j++) {
    const base = storeBases[j]!;
    const a = make16(n, j % 5);
    ramp16(a, base);
    console.log("ramp16", n, j, a.join(" "));
    const b = make16(n, (j + 2) % 5);
    index16(b, base);
    console.log("index16", n, j, b.join(" "));
    const c = makei16(n, j % 5);
    back16(c, base);
    console.log("back16", n, j, c.join(" "));
    const d = makei16(n, (j + 1) % 5);
    mix16(d);
    console.log("mix16", n, j, d.join(" "));
    const e = make16(n, j % 5);
    pair16(e, make16(n, (j + 3) % 5));
    console.log("pair16", n, j, e.join(" "));
    const lit = make16(n, j % 5);
    rampLit16(lit);
    console.log("ramplit16", n, j, lit.join(" "));
    const lit8 = make8(n, j % 5);
    shiftLit8(lit8);
    console.log("shiftlit8", n, j, lit8.join(" "));
    const back = makei16(n, (j + 1) % 5);
    backLit16(back);
    console.log("backlit16", n, j, back.join(" "));
    const litw = make32(n, j % 5);
    fillLit32(litw);
    console.log("filllit32", n, j, litw.join(" "));
  }
  for (let j = 0; j < storeInts.length; j++) {
    const k = storeInts[j]!;
    const sq = make32(n, j % 5);
    squareK32(sq, k);
    console.log("squarek32", n, j, sq.join(" "));
    const rm = make32(n, (j + 1) % 5);
    rampK32(rm, k);
    console.log("rampk32", n, j, rm.join(" "));
  }
}

/* Outer loops: a `for` whose body declares the row's own state, runs one
 * inner `while` to that row's own exit, and counts the rows whose inner loop
 * ran to its limit. The lanes take whole rows at a time, each lane's inner
 * loop exiting on its own with the false iterations dropped by a mask, so a
 * lane that takes one step too many or too few changes a printed count. The
 * rows below cover the value-object shape the plan inlines (numeric fields
 * only, methods that build a new instance), carried numbers assigned in an
 * order that matters, a three-field instance, and the tests the entry guard
 * makes on the counter's start, on the bound and on the accumulator. */

class Pair {
  re: number;
  im: number;
  constructor(re: number, im: number) {
    this.re = re;
    this.im = im;
  }
  plus(o: Pair): Pair {
    return new Pair(this.re + o.re, this.im + o.im);
  }
  times(o: Pair): Pair {
    return new Pair(this.re * o.re - this.im * o.im, this.re * o.im + this.im * o.re);
  }
  norm(): number {
    return this.re * this.re + this.im * this.im;
  }
}

class Other {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

// A three-field instance: every field is its own vector slot.
class Triple {
  a: number;
  b: number;
  c: number;
  constructor(a: number, b: number, c: number) {
    this.a = a;
    this.b = b;
    this.c = c;
  }
  next(d: Triple): Triple {
    return new Triple(this.a + d.a, this.b * 0.5 + d.b, this.c - d.c);
  }
}

// The value-objects shape: one row per outer iteration, the row's constant
// built before the inner loop, a two-field instance carried through it, and
// the count of rows that used up the limit.
function pairRow(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && z.norm() <= 4) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// The row with its counter's start and bound given separately, which is what
// the lane entry guard reads.
function pairRowRange(
  start: number,
  bound: number,
  size: number,
  limit: number,
  cim: number,
): number {
  let inside = 0;
  for (let x = start; x < bound; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && z.norm() <= 4) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// The accumulator's entry value is carried: the lanes count into it, so they
// take it only while it is an exact integer the lane count keeps exact.
function pairRowSeed(size: number, limit: number, cim: number, seed: number): number {
  let inside = seed;
  for (let x = 0; x < size; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && z.norm() <= 4) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// One inner statement per step, the second reading what the first stored: the
// lanes store each statement's group before the next one is evaluated, so a
// plan that reapplies the first statement's expression tree to the updated
// slots counts a different number of rows.
function pairRowStepwise(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && z.norm() <= 4) {
      z = z.plus(c);
      z = z.times(z);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// The row's constant built through a chain of declarations that each reuse
// the previous one. The declarations' slots are stored before the next
// declaration's value is computed, so the chain reads slots; inlining each
// declaration's tree into the next would make the row's constant grow with
// the chain and duplicate every step.
function pairRowChain(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    let t0 = (x / size) * 3 - 2;
    let t1 = t0 * 0.5 + 0.25;
    let t2 = t1 * 0.5 + 0.25;
    let t3 = t2 * 0.5 + 0.25;
    let t4 = t3 * 0.5 + 0.25;
    let t5 = t4 * 0.5 + 0.25;
    const c = new Pair(t5, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && z.norm() <= 4) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// Carried numbers, with the third assignment reading what the first left
// behind: the lanes compute and store one statement at a time.
function numberRow(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    const cre = (x / size) * 3 - 2;
    let zr = 0;
    let zi = 0;
    let keep = 0;
    let n = 0;
    while (n < limit && zr * zr + zi * zi <= 4) {
      keep = zr;
      zr = zr * zr - zi * zi + cre;
      zi = 2 * keep * zi + cim;
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// Three numeric fields, each a slot of its own.
function tripleWalk(count: number, steps: number): number {
  let done = 0;
  for (let i = 0; i < count; i++) {
    const d = new Triple(1, (i % 5) - 2, 0.25);
    let p = new Triple(0, 0, 0);
    let k = 0;
    while (k < steps && p.c < 4) {
      p = p.next(d);
      k++;
    }
    if (k === steps) done++;
  }
  return done;
}

// The inner test's boolean forms: a literal, a negation and a disjunction
// with a literal all reduce to the same mask.
function pairRowTrue(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && true && z.norm() <= 4) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

function pairRowNot(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (!(n >= limit) && z.norm() <= 4) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

function pairRowOr(size: number, limit: number, cim: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    const c = new Pair((x / size) * 3 - 2, cim);
    let z = new Pair(0, 0);
    let n = 0;
    while (n < limit && (z.norm() <= 4 || false)) {
      z = z.times(z).plus(c);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

// The value-objects workload's nested form: a row loop around the lane loop.
function fractal(size: number, limit: number): number {
  let inside = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = new Pair((x / size) * 3 - 2, (y / size) * 3 - 1.5);
      let z = new Pair(0, 0);
      let n = 0;
      while (n < limit && z.norm() <= 4) {
        z = z.times(z).plus(c);
        n++;
      }
      if (n === limit) inside++;
    }
  }
  return inside;
}

/* Rows the planner must refuse, kept scalar: a second inner loop, a
 * statement after the inner loop that is not the counted increment, a branch
 * inside it, an inner assignment to a local the row did not declare, a
 * carried value that changes class, a counter stepped by two, and a row whose
 * first statement is an assignment instead of a declaration. Each must print
 * what Node prints from its scalar loop. */

function rowTwoWhiles(size: number, limit: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    let n = 0;
    while (n < limit) n++;
    let m = 0;
    while (m < limit) m++;
    if (n + m === limit * 2) inside++;
  }
  return inside;
}

function rowSumN(size: number, limit: number): number {
  let total = 0;
  for (let x = 0; x < size; x++) {
    let n = 0;
    while (n < limit) n++;
    total = total + n;
  }
  return total;
}

function rowBranch(size: number, limit: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    let z = 0;
    let n = 0;
    while (n < limit && z < 4) {
      if (n % 2 === 0) z = z + 1;
      else z = z + 0.5;
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

function rowEscape(size: number, limit: number): number {
  let total = 0;
  for (let x = 0; x < size; x++) {
    let z = 0;
    let n = 0;
    while (n < limit) {
      z = z + 1;
      total = total + 1;
      n++;
    }
    if (n === limit) total++;
  }
  return total;
}

function rowSwapClass(size: number, limit: number): number {
  let inside = 0;
  for (let x = 0; x < size; x++) {
    let z = new Pair(0, 0);
    let o = new Other(0);
    let n = 0;
    while (n < limit) {
      z = new Pair(z.re + 1, z.im);
      o = new Other(o.v + 1);
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

function rowStride(size: number, limit: number): number {
  let inside = 0;
  for (let x = 0; x < size; x += 2) {
    let n = 0;
    while (n < limit) n++;
    if (n === limit) inside++;
  }
  return inside;
}

function rowNoDecl(size: number, limit: number, start: number): number {
  let zre = start;
  let inside = 0;
  for (let x = 0; x < size; x++) {
    zre = start;
    let n = 0;
    while (n < limit && zre * zre <= 4) {
      zre = zre * zre * 0.5;
      n++;
    }
    if (n === limit) inside++;
  }
  return inside;
}

const rowSizes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 16, 17, 23, 33];
const rowLimits = [0, 1, 2, 3, 4, 7, 16, 63];
const rowCims = [-1.5, -0.75, 0, 0.3, 1.2, NaN, Infinity];

for (const size of rowSizes) {
  for (const limit of rowLimits) {
    for (let j = 0; j < rowCims.length; j++) {
      const cim = rowCims[j]!;
      console.log(
        "row",
        size,
        limit,
        j,
        pairRow(size, limit, cim),
        numberRow(size, limit, cim),
        pairRowTrue(size, limit, cim),
        pairRowNot(size, limit, cim),
        pairRowOr(size, limit, cim),
        pairRowStepwise(size, limit, cim),
        pairRowChain(size, limit, cim),
      );
    }
  }
}

// The lane entry guard's bounds, from both sides: starts and bounds at the
// exact-integer ceiling, a start or bound past it, a fractional start and
// bound, and bounds that admit no row at all.
for (const [start, bound] of [
  [0, 33],
  [1, 33],
  [-3, 9],
  // Negative zero is not an exact integer for this guard: the lanes would
  // round its bits to positive zero and count a different number of rows.
  [-0, 9],
  [-0, 33],
  [2 ** 45 - 8, 2 ** 45],
  [2 ** 45 - 4, 2 ** 45],
  [2 ** 45 - 2, 2 ** 45],
  [2 ** 45 - 2, 2 ** 45 + 2],
  [2 ** 45, 2 ** 45 + 4],
  [2 ** 45 + 1, 2 ** 45 + 4],
  [-(2 ** 45), -(2 ** 45) + 8],
  [-(2 ** 45) - 4, -(2 ** 45) + 4],
  [0.5, 9.5],
  [0, 7.5],
  [-2.5, 4],
  [0, 0],
  [0, -1],
  [3, 3],
  [0, NaN],
  [0, -Infinity],
]) {
  const key = `${start},${bound}`;
  console.log(
    "range",
    key,
    pairRowRange(start!, bound!, 9, 20, -0.5),
    pairRowRange(start!, bound!, 9, 3, 0.75),
  );
}

// The accumulator's entry value, either side of the guard's ceiling.
for (const seed of [0, 1, -1, 2 ** 45 - 1, 2 ** 45, 2 ** 45 + 1, 0.5, -(2 ** 45) + 1, 2 ** 53]) {
  console.log(
    "seed",
    seed,
    pairRowSeed(7, 5, -0.5, seed),
    pairRowSeed(16, 20, -0.25, seed),
    pairRowSeed(7.5, 20, -0.25, seed),
  );
}

for (const count of [0, 1, 2, 3, 4, 5, 7, 8, 16, 17]) {
  for (const steps of [0, 1, 2, 3, 5, 20]) console.log("triple", count, steps, tripleWalk(count, steps));
}

for (const size of [0, 1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 24, 32]) {
  for (const limit of [0, 1, 3, 20]) {
    console.log(
      "fractal",
      size,
      limit,
      fractal(size, limit),
      fractal(size, limit),
      fractal(size + 0.5, limit),
    );
  }
}

for (const size of [0, 1, 3, 8, 17]) {
  for (const limit of [0, 1, 4, 11]) {
    console.log(
      "refused",
      size,
      limit,
      rowTwoWhiles(size, limit),
      rowSumN(size, limit),
      rowBranch(size, limit),
      rowEscape(size, limit),
      rowSwapClass(size, limit),
      rowStride(size, limit),
      rowNoDecl(size, limit, 1.5),
    );
  }
}
