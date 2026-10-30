// x / Math.pow(2, n) over every integer exponent from -1080 to 1030, against
// the same divisor read back from an array (an ordinary division): zeros,
// subnormals, values next to the limits, infinities and NaN, and a divisor of
// 2 ** n that is subnormal, zero or Infinity. Non-integer, signed-zero,
// infinite and NaN exponents give divisors that are not powers of two.
function bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

const values = [
  1, -1, 3, 0.1, -7.25, 0, -0, 5e-324, -5e-324, 2.2250738585072014e-308, 1.7976931348623157e308,
  -1.7976931348623157e308, 4503599627370497, 123456789.123, Infinity, -Infinity, NaN,
];
const divisors: number[] = [];
for (let n = -1080; n <= 1030; n++) divisors.push(Math.pow(2, n));

const scratch = new DataView(new ArrayBuffer(8));
let digest = 0;
let mismatches = 0;
for (let n = -1080; n <= 1030; n++) {
  const divisor = divisors[n + 1080]!;
  for (const x of values) {
    const quotient = x / Math.pow(2, n);
    const plain = x / divisor;
    scratch.setFloat64(0, quotient);
    digest = (Math.imul(digest, 31) + scratch.getUint32(0)) | 0;
    digest = (Math.imul(digest, 31) + scratch.getUint32(4)) | 0;
    if (!Object.is(quotient, plain)) {
      mismatches++;
      if (mismatches <= 5) console.log("mismatch", x, n, bits(quotient), bits(plain));
    }
  }
}
console.log("digest", (digest >>> 0).toString(16), "mismatches", mismatches);

for (const n of [-1075, -1074, -1023, -1022, -1, 0, 1, 52, 1022, 1023, 1024]) {
  console.log(n, bits(3 / Math.pow(2, n)), bits(-5e-324 / Math.pow(2, n)), bits(1.7976931348623157e308 / Math.pow(2, n)));
}
for (const e of [0.5, -0.5, -0, 1e-300, 1023.0000001, -1074.5, Infinity, -Infinity, NaN, 2 ** 31, -(2 ** 31)]) {
  console.log("exponent", e, bits(10 / Math.pow(2, e)), bits(-0 / Math.pow(2, e)));
}

// A divisor that changes every pass, and one computed once.
let total = 0;
for (let i = 0; i < 100000; i++) {
  const shift = (i % 40) - 20;
  total += (i * 7 + 3) / Math.pow(2, shift);
}
console.log("total", total);
let key = 12345;
const width = 34;
for (let i = 0; i < 100000; i++) {
  key = (key - Math.floor(key / Math.pow(2, width)) * Math.pow(2, width)) * 4 + (i % 4);
}
console.log("key", key);
