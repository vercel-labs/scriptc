// process.memoryUsage() counts the storage of ArrayBuffers, typed arrays,
// Buffers, DataViews and SharedArrayBuffers in arrayBuffers, and external
// includes arrayBuffers. A view over existing storage adds nothing.
const size = 4 * 1024 * 1024;
const grew = (before, after) =>
  [after.arrayBuffers - before.arrayBuffers >= size, after.external - before.external >= size];
const sample = () => process.memoryUsage();

let before = sample();
console.log(typeof before.arrayBuffers, typeof before.external, before.external >= before.arrayBuffers);
const ab = new ArrayBuffer(size);
console.log("ArrayBuffer", ab.byteLength, ...grew(before, sample()));

before = sample();
const f64 = new Float64Array(size / 8);
console.log("Float64Array", f64.byteLength, ...grew(before, sample()));

before = sample();
const buf = Buffer.alloc(size, 1);
console.log("Buffer.alloc", buf.length, ...grew(before, sample()));

before = sample();
const unsafe = Buffer.allocUnsafeSlow(size);
console.log("Buffer.allocUnsafeSlow", unsafe.length, ...grew(before, sample()));

before = sample();
const text = Buffer.from("x".repeat(size));
console.log("Buffer.from(string)", text.length, ...grew(before, sample()));

before = sample();
const sab = new SharedArrayBuffer(size);
const shared = new Int32Array(sab);
console.log("SharedArrayBuffer", sab.byteLength, shared.length, ...grew(before, sample()));

before = sample();
const views = [new DataView(ab), buf.subarray(1), new Uint8Array(f64.buffer, 8, 16)];
const after = sample();
console.log("views", views.length, after.arrayBuffers - before.arrayBuffers < size);

const all = sample();
console.log(all.arrayBuffers >= 6 * size, all.external >= all.arrayBuffers);
