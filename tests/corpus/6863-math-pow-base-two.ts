// Math.pow(2, n) with a literal base of 2 and with a base of 2 in a variable,
// over every integer exponent from -1080 to 1030: subnormal results down to
// 2 ** -1074, zero below it, Infinity above 1023. Non-integer, signed-zero,
// infinite and NaN exponents, and bases next to 2, take the general path.
function bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

function show(label: string, x: number): void {
  console.log(label, bits(x), Object.is(x, -0) ? "-0" : String(x));
}

let base = 2;
if (process.argv.length > 99) base = 3;

let literalDigest = 0n;
let variableDigest = 0n;
let mismatches = 0;
for (let n = -1080; n <= 1030; n++) {
  const literal = Math.pow(2, n);
  const variable = Math.pow(base, n);
  literalDigest = (literalDigest * 31n + BigInt(`0x${bits(literal)}`)) & 0xffffffffffffffffn;
  variableDigest = (variableDigest * 31n + BigInt(`0x${bits(variable)}`)) & 0xffffffffffffffffn;
  if (!Object.is(literal, variable)) mismatches++;
  if (n <= -1070 || (n >= -1025 && n <= -1019) || (n >= -2 && n <= 2) || (n >= 51 && n <= 54) || n >= 1021) {
    show(`2 ** ${n}`, literal);
  }
}
console.log("digests", literalDigest.toString(16), variableDigest.toString(16), "mismatches", mismatches);

const exponents = [0.5, -0.5, 1.5, -0, 0, 1e-300, -1e-300, 1023.0000001, 1022.9999999, -1074.5, -1073.5, Infinity, -Infinity, NaN, 52.999999999999996, 2 ** 31, -(2 ** 31)];
for (const e of exponents) {
  show(`literal ${e}`, Math.pow(2, e));
  show(`variable ${e}`, Math.pow(base, e));
}
for (const b of [-2, 2.0000000000000004, 1.9999999999999998, 4, 0.5]) {
  show(`${b} ** 10`, Math.pow(b, 10));
  show(`${b} ** -3`, Math.pow(b, -3));
}

// In a loop that masks values, as a k-mer counter does.
let key = 0;
let total = 0;
for (let i = 0; i < 100000; i++) {
  const length = (i % 18) + 1;
  key = (key * 4 + (i % 4)) % Math.pow(2, 2 * length);
  total += key - Math.floor(key / Math.pow(2, length)) * Math.pow(2, length);
}
console.log("masked total", total);
