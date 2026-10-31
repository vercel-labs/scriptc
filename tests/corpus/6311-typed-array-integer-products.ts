// Products and sums of typed-array element reads that only reach bitwise
// operators compute in 32-bit integers. Results must match Node for reads
// past the end (NaN, which converts to 0), negative factors, products that
// can be -0, sums that wrap past int32, and products near 2^53.

const rgba = new Uint8Array([10, 20, 30, 255, 200, 100, 50, 0, 255, 255, 255, 128, 0, 0, 0, 1]);
const pixels = rgba.length / 4;
const gray = new Uint8Array(pixels);
for (let i = 0; i < gray.length; i++) {
  const j = i * 4;
  gray[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
}
console.log("gray", gray.join(","));

// Reads past the end are NaN: the sum is NaN and converts to 0.
const tail: number[] = [];
for (let i = pixels - 2; i < pixels + 2; i++) {
  const j = i * 4;
  tail.push((rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8);
  tail.push((rgba[j + 3]! * 3 - rgba[j]!) | 0);
}
console.log("tail", tail.join(","));

// Signed elements and negative factors, including products that are -0.
const signed = new Int8Array([0, -1, 1, -128, 127, 0, 5, -5]);
const mixed: number[] = [];
for (let i = 0; i < signed.length; i++) {
  mixed.push((signed[i]! * -3) | 0);
  mixed.push((signed[i]! * signed[(i + 1) % signed.length]! + signed[i]! * 1000) >> 1);
  mixed.push(Object.is(signed[i]! * -1, -0) ? 1 : 0);
}
console.log("signed", mixed.join(","));

// Unsigned 16-bit products whose sum passes int32 and wraps.
const wide = new Uint16Array([65535, 65535, 1, 40000, 50000, 12345]);
const wrapped: number[] = [];
for (let i = 0; i + 1 < wide.length; i++) {
  wrapped.push((wide[i]! * wide[i + 1]! + wide[i]! * wide[i]!) | 0);
  wrapped.push((wide[i]! * wide[i + 1]!) >>> 0);
  wrapped.push((wide[i]! * 65537 - wide[i + 1]!) ^ 0x5a5a);
}
console.log("uint16", wrapped.join(","));

// Unsigned 32-bit elements times constants just below and above 2^53.
const big = new Uint32Array([0xffffffff, 0x80000000, 3, 0]);
const near: number[] = [];
for (let i = 0; i < big.length; i++) {
  near.push((big[i]! * 2097151) | 0);
  near.push((big[i]! * 2097153) | 0);
  near.push((big[i]! * 2097151 + big[(i + 1) % big.length]!) >>> 0);
}
console.log("uint32", near.join(","));

// A float element is never an exact integer.
const floats = new Float64Array([1.5, -2.25, 3]);
const fractional: number[] = [];
for (let i = 0; i < floats.length; i++) fractional.push((floats[i]! * 3 + floats[i]! * 2) | 0);
console.log("float", fractional.join(","));

// Clamped bytes and a sum used as a number keep their double values.
const clamped = new Uint8ClampedArray([0, 128, 255]);
let total = 0;
for (let i = 0; i < clamped.length; i++) {
  total += clamped[i]! * 77 + clamped[i]! * 0.5;
  total += (clamped[i]! * 77 + clamped[(i + 1) % 3]! * 150) >> 8;
}
console.log("clamped", total);

// A larger image, so the loop runs its vectorized body.
const image = new Uint8Array(4 * 1000);
for (let i = 0; i < image.length; i++) image[i] = (i * 37 + (i >> 3)) & 255;
const luma = new Uint8Array(1000);
for (let i = 0; i < luma.length; i++) {
  const j = i * 4;
  luma[i] = (image[j]! * 77 + image[j + 1]! * 150 + image[j + 2]! * 29) >> 8;
}
let sum = 0;
let mix = 0;
for (let i = 0; i < luma.length; i++) {
  sum += luma[i]!;
  mix = (mix * 31 + luma[i]!) | 0;
}
console.log("luma", sum, mix);
