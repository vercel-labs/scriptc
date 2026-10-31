// Math's transcendental functions print the values Node prints: each line
// digests the result bits of one function over a few thousand inputs, so
// a difference in the last bit of any result changes the line. Sample
// values print in full, and pow's special cases follow V8's.
const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);

function digest(values: number[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const v of values) {
    // NaN prints as NaN; its bits are not part of the result.
    bits[0] = Number.isNaN(v) ? 0 : v;
    h1 = Math.imul(h1 ^ words[0], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ words[1], 0x01000193) >>> 0;
  }
  return `${h1}:${h2}`;
}

let seed = 12345;
function next(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

const wide: number[] = [];
const unit: number[] = [];
const small: number[] = [];
for (let i = 0; i < 3000; i++) {
  wide.push((next() - 0.5) * Math.pow(10, Math.floor(next() * 12) - 4));
  unit.push(next() * 2 - 1);
  small.push((next() - 0.5) * 40);
}
const positive = wide.map((x) => Math.abs(x));
const edges = [0, -0, 1, -1, 0.5, -0.5, 2, Math.PI, Math.E, 1e-300, 5e-324, 1e300, Infinity, -Infinity, NaN];

const unary: [string, (x: number) => number, number[]][] = [
  ["sin", Math.sin, wide],
  ["cos", Math.cos, wide],
  ["tan", Math.tan, wide],
  ["asin", Math.asin, unit],
  ["acos", Math.acos, unit],
  ["atan", Math.atan, wide],
  ["sinh", Math.sinh, small],
  ["cosh", Math.cosh, small],
  ["tanh", Math.tanh, small],
  ["asinh", Math.asinh, wide],
  ["acosh", Math.acosh, positive.map((x) => x + 1)],
  ["atanh", Math.atanh, unit],
  ["exp", Math.exp, small],
  ["expm1", Math.expm1, small],
  ["log", Math.log, positive],
  ["log1p", Math.log1p, positive],
  ["log2", Math.log2, positive],
  ["log10", Math.log10, positive],
  ["cbrt", Math.cbrt, wide],
  ["sqrt", Math.sqrt, positive],
];
for (const [name, fn, inputs] of unary) {
  console.log(name, digest(inputs.map(fn)), digest(edges.map(fn)), fn(0.3), fn(0.75));
}

// Math.sin(i) and Math.cos(i * 0.37) for i below 4096: main's libm calls
// printed 284 of these 8192 values differently from Node.
const sines: number[] = [];
const cosines: number[] = [];
for (let i = 0; i < 4096; i++) {
  sines.push(Math.sin(i));
  cosines.push(Math.cos(i * 0.37));
}
console.log("sin(i)", digest(sines), "cos(i*0.37)", digest(cosines), Math.cos(2.59));

const atan2: number[] = [];
const pow: number[] = [];
for (let i = 0; i < wide.length; i++) {
  atan2.push(Math.atan2(wide[i], small[i]));
  pow.push(Math.pow(positive[i] % 50, small[i] / 4));
}
console.log("atan2", digest(atan2), Math.atan2(2.5, 3), Math.atan2(-0, -1));
console.log("pow", digest(pow), Math.pow(1.1, 0.3), 1.0000001 ** 1e7);

// V8 answers these itself: x * x, the square root, and NaN for ±1 ** ±Infinity.
const squares = wide.map((x) => x ** 2);
const roots = positive.map((x) => Math.pow(x, 0.5));
console.log("pow 2", digest(squares), "pow 0.5", digest(roots));
// The same exponents when they are only known at run time.
const two = Number(process.argv[2] ?? "2");
const half = two / 4;
console.log("pow runtime 2", digest(wide.map((x) => x ** two)), "0.5", digest(positive.map((x) => Math.pow(x, half))));
console.log(Math.pow(-Infinity, 0.5), Math.pow(-0, 0.5), (-8) ** 0.5, 1 ** Infinity, (-1) ** -Infinity, NaN ** 0);
// Rounding is exact: Math.floor, Math.ceil and Math.trunc over the same
// inputs and over halves, signed zeros included.
const halves = wide.map((x, i) => Math.round(x * 4) / 4 - (i % 2 === 0 ? 0 : 0.5));
console.log("floor", digest(wide.map(Math.floor)), digest(halves.map(Math.floor)), digest(edges.map(Math.floor)));
console.log("ceil", digest(wide.map(Math.ceil)), digest(halves.map(Math.ceil)), digest(edges.map(Math.ceil)));
console.log("trunc", digest(wide.map(Math.trunc)), digest(halves.map(Math.trunc)), Object.is(Math.ceil(-0.5), -0), Object.is(Math.floor(-0), -0));
console.log(Math.hypot(3, 4), Math.hypot(1e200, 1e200), 7 % 2.5, -7.5 % 2, Math.floor(-0.5), Math.ceil(-0.5), Math.round(2.5), Math.trunc(-4.7));
