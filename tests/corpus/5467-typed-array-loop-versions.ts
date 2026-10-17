// Typed-array loops whose accesses are proved in bounds by one test before
// the loop run without per-element checks; every other entry runs the
// checked loop. Both must keep JavaScript's exact out-of-bounds behavior:
// reads of missing elements are undefined (NaN in arithmetic), writes are
// ignored, DataView accesses throw at the failing iteration, and
// fractional, negative and NaN indices never touch storage.

const table: Int32Array = new Int32Array(256);
for (let n = 0; n < 256; n++) table[n] = (n * 2654435761) | 0;
const shortTable: Int32Array = new Int32Array(100);
for (let n = 0; n < 100; n++) shortTable[n] = n + 1;

function masked(t: Int32Array, data: Uint8Array): number {
  let h = 0;
  for (let i = 0; i < data.length; i++) h = (h ^ t[(h ^ data[i]) & 0xff]) | 0;
  return h;
}

function maskedWrite(t: Int32Array, count: number): void {
  for (let i = 0; i < count; i++) t[(i * 7) & 0xff] = i;
}

const data = new Uint8Array(64);
for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;
console.log("masked full", masked(table, data));
console.log("masked short", masked(shortTable, data));
const writable = new Int32Array(200);
maskedWrite(writable, 300);
console.log("masked write", writable[0], writable[7], writable[199], writable.length);

// Counter plus an invariant base, in bounds and running off either end.
function shifted(src: Float64Array, out: Float64Array, base: number, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[base + i] = src[i] * 2;
    sum += src[base + i - 1];
  }
  return sum;
}

const src = new Float64Array(8);
for (let i = 0; i < 8; i++) src[i] = i + 0.25;
for (const [base, n] of [
  [1, 4],
  [0, 8],
  [5, 8],
  [-3, 6],
  [2, 0],
  [3, 2.5],
]) {
  const out = new Float64Array(8);
  const sum = shifted(src, out, base, n);
  console.log("shifted", base, n, sum, Array.from(out).join(","));
}

// Descending loops, including ones that walk below zero.
function descending(a: Uint16Array, low: number): number {
  let sum = 0;
  for (let i = a.length - 1; i >= low; i--) {
    a[i] = a[i] + 1000;
    sum += a[i];
  }
  return sum;
}
const u16 = new Uint16Array([65000, 1, 2, 3]);
console.log("descending", descending(u16, 0), Array.from(u16).join(","));
console.log("descending below", descending(u16, -2), Array.from(u16).join(","));

// Fractional starts and offsets never name an element.
function fractional(a: Float32Array): string {
  const seen: string[] = [];
  for (let i = 0.5; i < 3; i++) seen.push(String(a[i]));
  for (let i = 0; i < 3; i++) {
    a[i + 0.5] = 99;
    seen.push(String(a[i] + a[i - 0.5]));
  }
  return seen.join(" ");
}
console.log("fractional", fractional(new Float32Array([1.5, 2.5, 3.5])));

function nanIndex(a: Int8Array, offset: number): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    a[i + offset] = 120;
    sum += a[i + offset] | 0;
  }
  return sum;
}
const i8 = new Int8Array([1, 2, 3]);
console.log("nan index", nanIndex(i8, NaN), nanIndex(i8, -0), Array.from(i8).join(","));

// Unproven limits keep the integer loop's guard: huge, infinite and NaN.
function limits(a: Uint8Array, limit: number): number {
  let sum = 0;
  for (let i = 0; i < limit; i++) {
    if (i >= a.length + 2) break;
    sum += a[i] | 0;
    a[i] = i;
  }
  return sum;
}
const lim = new Uint8Array([5, 6, 7]);
console.log("limits", limits(lim, 2), limits(lim, 1e300), limits(lim, Infinity), limits(lim, NaN));

// A DataView access past the end throws after the earlier iterations ran.
const viewProgress: number[] = [0];
function viewLoop(view: DataView, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += view.getUint32(i * 4, true) + view.getUint8(i * 4 + 3);
    viewProgress[0] = sum;
  }
  return sum;
}
function viewSum(view: DataView, n: number): number {
  viewProgress[0] = -1;
  try {
    return viewLoop(view, n);
  } catch (e) {
    console.log("view throw", (e as Error).name, viewProgress[0]);
  }
  return viewProgress[0];
}
const dvBytes = new Uint8Array(16);
for (let i = 0; i < 16; i++) dvBytes[i] = i * 3;
const view = new DataView(dvBytes.buffer);
console.log("view ok", viewSum(view, 4));
console.log("view partial", viewSum(view, 6));

// Strided loops: the last counter value of a non-unit step is exact, so a
// record that ends at the last element still takes the unchecked loop and
// a partial trailing record does not.
function quads(words: Uint16Array): number {
  let sum = 0;
  for (let i = 0; i < words.length; i += 4) sum += words[i] + words[i + 3] * 2;
  return sum;
}
console.log("quads", quads(new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8])));
console.log("quads partial", quads(new Uint16Array([1, 2, 3, 4, 5, 6])));
function backTriples(words: Uint16Array): number {
  let sum = 0;
  for (let i = words.length - 1; i >= 0; i -= 3) sum = sum * 3 + words[i] + (words[i - 2] | 0);
  return sum;
}
console.log("back triples", backTriples(new Uint16Array([1, 2, 3, 4, 5, 6])));
console.log("back triples partial", backTriples(new Uint16Array([1, 2, 3, 4, 5, 6, 7])));
function scaled(words: Uint16Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += words[i * 2] - (words[(i + 1) * 2 - 1] | 0) + (words[9 - i] | 0);
  return sum;
}
const scaledWords = new Uint16Array(10);
for (let i = 0; i < 10; i++) scaledWords[i] = i * i;
console.log("scaled", scaled(scaledWords, 5), scaled(scaledWords, 6), scaled(scaledWords, 11));
// A negative zero index names element 0 and stays -0 as a number.
function negativeZero(words: Uint16Array, n: number): string {
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = i * -1;
    const m = (i - 1) * 2;
    seen.push(`${words[k]}:${Object.is(k, -0)}:${words[m] | 0}:${Object.is(m, -0)}`);
  }
  return seen.join(" ");
}
console.log("negative zero", negativeZero(scaledWords, 3));

// Clamped and wrapping element types on the unchecked path.
function convert(c: Uint8ClampedArray, s: Int16Array): string {
  for (let i = 0; i < 4; i++) {
    c[i] = i * 100 - 50.5;
    s[i] = i * 20000;
  }
  return Array.from(c).join(",") + " " + Array.from(s).join(",");
}
console.log("convert", convert(new Uint8ClampedArray(4), new Int16Array(4)));

// Module receivers stay correct across calls in the loop body, including a
// call that writes the same arrays.
const left: Float64Array = new Float64Array(16);
const right: Float64Array = new Float64Array(16);
function poke(k: number): number {
  right[k] = right[k] + 1;
  return k;
}
for (let i = 0; i < 16; i++) left[i] = i;
let crossed = 0;
for (let i = 0; i < 16; i++) {
  right[i] = left[i] * 3;
  crossed += right[poke(i)];
}
console.log("module receivers", crossed, right[0], right[15]);

// A body that reassigns its receiver keeps reading the current binding.
function rebinding(first: Uint8Array, second: Uint8Array): number {
  let current = first;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += current[i] | 0;
    if (i === 1) current = second;
  }
  return sum;
}
console.log("rebinding", rebinding(new Uint8Array([1, 2, 3, 4]), new Uint8Array([10, 20])));

// A throwing body leaves the writes of earlier iterations in place.
function failing(a: Uint32Array, at: number): void {
  for (let i = 0; i < a.length; i++) {
    if (i === at) throw new Error("stop at " + i);
    a[i] = 4294967295 - i;
  }
}
const u32 = new Uint32Array(5);
try {
  failing(u32, 3);
} catch (e) {
  console.log((e as Error).message, Array.from(u32).join(","));
}

// An outer loop proved in bounds around an inner loop that is not.
function nested(grid: Int32Array, w: number, h: number): number {
  let sum = 0;
  for (let y = 0; y < h; y++) {
    sum += grid[y & 7];
    for (let x = 0; x < w; x++) {
      grid[y * w + x] = grid[y * w + x] + 1;
      sum += grid[y * w + x] | 0;
    }
  }
  return sum;
}
const grid = new Int32Array(16);
console.log("nested", nested(grid, 4, 4), nested(grid, 5, 4), nested(grid, 4, 5), grid.join(","));

// A matrix product over module-level constant arrays.
const N = 6;
const ma: Float64Array = new Float64Array(N * N);
const mb: Float64Array = new Float64Array(N * N);
const mc: Float64Array = new Float64Array(N * N);
for (let i = 0; i < N * N; i++) {
  ma[i] = (i % 7) - 3;
  mb[i] = (i % 5) * 0.5;
}
for (let i = 0; i < N; i++) {
  for (let k = 0; k < N; k++) {
    const aik = ma[i * N + k];
    const kOff = k * N;
    const iOff = i * N;
    for (let j = 0; j < N; j++) mc[iOff + j] += aik * mb[kOff + j];
  }
}
let trace = 0;
for (let i = 0; i < N; i++) trace += mc[i * N + i];
console.log("matmul", trace, mc[1], mc[N * N - 1]);
