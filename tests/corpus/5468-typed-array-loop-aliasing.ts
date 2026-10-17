// Element stores may alias any other view of the same buffer, whatever its
// element type, offset or length, but never a typed array's own length and
// data pointer. Loops that write through one view and read through another
// must observe every store in program order, also when the loop runs
// without per-element bounds checks.

const buffer = new ArrayBuffer(64);
const f64 = new Float64Array(buffer);
const u8 = new Uint8Array(buffer);
const i32 = new Int32Array(buffer, 8, 8);

// Writes through Float64Array observed through a Uint8Array in the same
// iteration.
let topBytes = 0;
for (let i = 0; i < f64.length; i++) {
  f64[i] = -(i + 1) * 1.5;
  topBytes += u8[i * 8 + 7];
}
console.log("f64 then u8", topBytes, u8[7], u8[63]);

// Byte stores observed through an overlapping Int32Array window.
let words = 0;
for (let i = 0; i < 32; i++) {
  u8[8 + i] = i + 1;
  words = (words + i32[i >> 2]) | 0;
}
console.log("u8 then i32", words, i32[0], i32[7]);

// A shifted subarray reads what the previous iteration wrote: a prefix
// recurrence that any reordering or vector widening would break.
const chain = new Uint8Array(40);
chain[0] = 1;
const ahead = chain.subarray(1);
for (let i = 0; i < ahead.length; i++) ahead[i] = chain[i] + 2;
console.log("recurrence", chain[0], chain[1], chain[20], chain[39]);

// Overlapping copies in both directions.
const values = new Int16Array(12);
for (let i = 0; i < values.length; i++) values[i] = i * 10;
const lower = values.subarray(0, 11);
const upper = values.subarray(1);
for (let i = 0; i < lower.length; i++) lower[i] = upper[i];
console.log("copy down", Array.from(values).join(","));
for (let i = 0; i < values.length; i++) values[i] = i * 10;
for (let i = 0; i < lower.length; i++) upper[i] = lower[i];
console.log("copy up", Array.from(values).join(","));

// Same-array accumulation with a lagging read.
function lagged(a: Float64Array, lag: number): number {
  for (let i = lag; i < a.length; i++) a[i] = a[i] + a[i - lag];
  return a[a.length - 1];
}
const fib = new Float64Array(30);
fib[0] = 1;
fib[1] = 1;
console.log("lagged", lagged(fib, 1), lagged(fib, 2));

// Two parameters that are the same array, and a destination that aliases
// part of its own source.
function axpy(alpha: number, x: Float64Array, y: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) y[i] = y[i] + alpha * x[i];
}
const same = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
axpy(2, same, same, same.length);
console.log("axpy same", Array.from(same).join(","));
const whole = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
axpy(1, whole, whole.subarray(2), 6);
console.log("axpy shifted", Array.from(whole).join(","));

// Element stores never change a length or a module binding, even when a
// float store writes the bit pattern of a small length.
const meta: Float64Array = new Float64Array(4);
const lengths: number[] = [];
for (let i = 0; i < 4; i++) {
  meta[i] = 5e-324 * (i + 1);
  lengths.push(meta.length);
}
console.log("lengths", lengths.join(","), meta[3] > 0);

// Global numbers next to typed-array stores keep their values.
let scale = 3;
const scaled: Float32Array = new Float32Array(6);
for (let i = 0; i < scaled.length; i++) {
  scaled[i] = scale * i;
  if (i === 2) scale = 0.5;
}
console.log("scaled", Array.from(scaled).join(","));
