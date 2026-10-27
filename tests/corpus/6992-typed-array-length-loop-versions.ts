// Loops bounded by one typed array's length that index other typed arrays:
// equal and different lengths, offsets, mixed element types and views that
// share a buffer. Out-of-bounds reads give undefined (NaN in arithmetic) and
// out-of-bounds writes are ignored, whichever array is shorter.

function mulInto(x: Float32Array, y: Float32Array, out: Float32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = x[i]! * y[i]!;
}

function axpy(a: number, x: Float64Array, y: Float64Array, out: Float64Array): void {
  for (let i = 0; i < out.length; i++) out[i] = a * x[i]! + y[i]!;
}

function xorInto(a: Uint8Array, b: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < out.length; i++) out[i] = a[i]! ^ b[i]!;
}

function addWrap(a: Int32Array, b: Int32Array, out: Int32Array): void {
  for (let i = 0; i < out.length; i++) out[i] = (a[i]! + b[i]!) | 0;
}

function narrow(src: Float64Array, i8: Int8Array, u16: Uint16Array, u32: Uint32Array): void {
  for (let i = 0; i < src.length; i++) {
    i8[i] = src[i]!;
    u16[i] = src[i]!;
    u32[i] = src[i]!;
  }
}

function neighbors(a: Int32Array, out: Int32Array): void {
  for (let i = 0; i < a.length; i++) out[i] = a[i + 1]! - a[i]!;
}

function previous(a: Float64Array, out: Float64Array): void {
  for (let i = 0; i < out.length; i++) out[i] = a[i - 1]!;
}

function gray(px: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (px[j]! * 77 + px[j + 1]! * 150 + px[j + 2]! * 29) >> 8;
  }
}

function sumPairs(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function shiftUp(view: Uint8Array, from: Uint8Array): void {
  for (let i = 0; i < view.length; i++) view[i] = from[i]! + 1;
}

const n = 37;
const fx = new Float32Array(n);
const fy = new Float32Array(n);
const dx = new Float64Array(n);
const dy = new Float64Array(n);
const ba = new Uint8Array(n);
const bb = new Uint8Array(n);
const ia = new Int32Array(n);
const ib = new Int32Array(n);
for (let i = 0; i < n; i++) {
  fx[i] = i / 3;
  fy[i] = 0.1 * i - 1.7;
  dx[i] = i * 1.25 - 9;
  dy[i] = (i * 7) % 11;
  ba[i] = (i * 29) & 255;
  bb[i] = (i * 113 + 7) & 255;
  ia[i] = i * 0x3fffffff;
  ib[i] = i * -0x2ffffff1;
}

const fo = new Float32Array(n);
mulInto(fx, fy, fo);
console.log("f32", fo.join(","));
const shortF = new Float32Array(5);
mulInto(fx, fy.subarray(0, 3), shortF);
console.log("f32 short input", shortF.join(","));
const longF = new Float32Array(n + 4);
mulInto(fx, fy, longF);
console.log("f32 long output", longF.subarray(n - 2).join(","));

const dout = new Float64Array(n);
axpy(-2.5, dx, dy, dout);
console.log("axpy", dout.join(","));
axpy(0.5, dx.subarray(10), dy, dout);
console.log("axpy short x", dout.subarray(20).join(","));

const bo = new Uint8Array(n);
xorInto(ba, bb, bo);
console.log("xor", bo.join(","));
const io = new Int32Array(n);
addWrap(ia, ib, io);
console.log("i32", io.join(","));

const src = new Float64Array([0, -1, 1.5, -128.5, 255.7, 256, 65535.9, -65537, 4294967296.5, NaN, Infinity, -0]);
const i8 = new Int8Array(src.length);
const u16 = new Uint16Array(src.length - 2);
const u32 = new Uint32Array(src.length + 1);
narrow(src, i8, u16, u32);
console.log("narrow", i8.join(","), "|", u16.join(","), "|", u32.join(","));

const diff = new Int32Array(n);
neighbors(ia, diff);
console.log("neighbors", diff.subarray(n - 3).join(","));
const before = new Float64Array(4);
previous(dx, before);
console.log("previous", before.join(","));

const px = new Uint8Array(n * 4);
for (let i = 0; i < px.length; i++) px[i] = (i * 53) & 255;
const g = new Uint8Array(n);
gray(px, g);
console.log("gray", g.join(","));
const wide = new Uint8Array(n + 3);
gray(px, wide);
console.log("gray past input", wide.subarray(n - 1).join(","));

console.log("dot", sumPairs(dx, dy), sumPairs(dx, dy.subarray(0, 30)));

// Views of one buffer: writes through one are visible to reads through the
// other on later iterations.
const buffer = new Uint8Array(24);
for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 37) & 255;
shiftUp(buffer.subarray(1), buffer);
console.log("overlap forward", buffer.join(","));
for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 37) & 255;
shiftUp(buffer, buffer.subarray(1));
console.log("overlap backward", buffer.join(","));
const shared = new ArrayBuffer(64);
const asFloat = new Float32Array(shared);
const asBytes = new Uint8Array(shared, 4, 16);
for (let i = 0; i < asFloat.length; i++) asFloat[i] = i + 0.5;
const fromBytes = new Float32Array(16);
for (let i = 0; i < fromBytes.length; i++) {
  asBytes[i] = i * 3;
  fromBytes[i] = asFloat[i]!;
}
console.log("mixed views", fromBytes.join(","), asBytes.join(","));
