// Element-wise loops over several typed arrays: each loop runs to one
// array's length and reads or writes the others at the same index. Also a
// row-major matrix-vector product with four accumulators per row.

function axpy(a: number, x: Float64Array, y: Float64Array, out: Float64Array): void {
  for (let i = 0; i < out.length; i++) out[i] = a * x[i]! + y[i]!;
}

function blend(t: number, a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = a[i]! * (1 - t) + b[i]! * t;
}

function mask(data: Uint8Array, key: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < out.length; i++) out[i] = data[i]! ^ key[i]!;
}

function addWrap(a: Int32Array, b: Int32Array, out: Int32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = (a[i]! + b[i]!) | 0;
}

function brighten(src: Uint8ClampedArray, gain: number, out: Uint8ClampedArray): void {
  for (let i = 0; i < out.length; i++) out[i] = src[i]! * gain + 8;
}

function matvec(w: Float32Array, x: Float32Array, out: Float32Array, cols: number): void {
  for (let r = 0; r < out.length; r++) {
    const base = r * cols;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let j = 0; j < cols; j += 4) {
      s0 += w[base + j]! * x[j]!;
      s1 += w[base + j + 1]! * x[j + 1]!;
      s2 += w[base + j + 2]! * x[j + 2]!;
      s3 += w[base + j + 3]! * x[j + 3]!;
    }
    out[r] = s0 + s1 + s2 + s3;
  }
}

// Callback methods over a whole typed array.
function callbacks(samples: Float32Array, limit: number, data: Uint8Array): number {
  const energy = samples.reduce((sum, v) => sum + v * v, 0);
  const loud = samples.some((v) => v > limit) ? 1 : 0;
  const halved = data.map((v) => v >> 1);
  return energy / samples.length + loud + halved[halved.length >> 1]!;
}

function gray(rgba: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
  }
}

const scale = Number(process.argv[2] ?? "1");
const n = 1 << 16;
const x = new Float64Array(n);
const y = new Float64Array(n);
const d = new Float64Array(n);
const fa = new Float32Array(n);
const fb = new Float32Array(n);
const fo = new Float32Array(n);
const data = new Uint8Array(n);
const key = new Uint8Array(n);
const masked = new Uint8Array(n);
const ia = new Int32Array(n);
const ib = new Int32Array(n);
const io = new Int32Array(n);
const pixels = new Uint8ClampedArray(n);
const bright = new Uint8ClampedArray(n);
const rgba = new Uint8Array(n * 4);
const side = 256;
const weights = new Float32Array(side * side);
const vector = new Float32Array(side);
const product = new Float32Array(side);
const luma = new Uint8Array(n);
let state = 2463534242;
const next = (): number => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
};
for (let i = 0; i < n; i++) {
  x[i] = (next() % 20000) / 100 - 100;
  y[i] = (next() % 20000) / 100;
  fa[i] = (next() % 1000) / 7;
  fb[i] = (next() % 1000) / 9;
  data[i] = next() & 255;
  key[i] = next() & 255;
  ia[i] = next() | 0;
  ib[i] = next() | 0;
  pixels[i] = next() & 255;
}
for (let i = 0; i < rgba.length; i++) rgba[i] = next() & 255;
for (let i = 0; i < weights.length; i++) weights[i] = (next() % 2001) / 1000 - 1;
for (let i = 0; i < side; i++) vector[i] = (next() % 1001) / 1000;

const rounds = Math.round(1200 * scale);
let f64Sum = 0;
let f32Sum = 0;
let byteSum = 0;
let intSum = 0;
let brightSum = 0;
let lumaSum = 0;
let productSum = 0;
let callbackSum = 0;
for (let r = 0; r < rounds; r++) {
  // Change one input element per round so no round repeats the last.
  const at = (r * 7919) & (n - 1);
  x[at] = r;
  fa[at] = r;
  data[at] = r & 255;
  ia[at] = r * 65537;
  pixels[at] = r & 255;
  rgba[at * 4] = r & 255;
  vector[r & (side - 1)] = (r % 1001) / 1000;
  axpy(1.5, x, y, d);
  blend((r & 15) / 16, fa, fb, fo);
  mask(data, key, masked);
  addWrap(ia, ib, io);
  brighten(pixels, 0.75 + (r & 7) / 8, bright);
  gray(rgba, luma);
  matvec(weights, vector, product, side);
  if ((r & 3) === 0) callbackSum += callbacks(fo, 140 + (r & 12), masked);
  const probe = (r * 104729) & (n - 1);
  f64Sum += d[probe]!;
  f32Sum += fo[probe]!;
  byteSum += masked[probe]!;
  intSum = (intSum + io[probe]!) | 0;
  brightSum += bright[probe]!;
  lumaSum += luma[probe]!;
  productSum += product[probe & (side - 1)]!;
}
console.log(`float64 ${f64Sum.toFixed(3)}`);
console.log(`float32 ${f32Sum.toFixed(3)}`);
console.log(`uint8 ${byteSum}`);
console.log(`int32 ${intSum}`);
console.log(`clamped ${brightSum}`);
console.log(`gray ${lumaSum}`);
console.log(`matvec ${productSum.toFixed(3)}`);
console.log(`callbacks ${callbackSum.toFixed(3)}`);
