// Products that reach bitwise operators with operands whose ranges are
// known, around 2^53: below it the double product is exact, and from it on
// the double product rounds, so the 32-bit result comes from the rounded
// value (3 * 3002399751580331 is 2^53 + 1, which rounds to 2^53).
const pairs: [number, number][] = [
  [3, 3002399751580331],
  [-3, 3002399751580331],
  [2 ** 26, 2 ** 27],
  [94906265, 94906267],
  [94906267, 94906267],
  [7, 1286742750677284],
  [65535, 137443147777],
];
for (const [a, b] of pairs) console.log(a, b, (a * b) | 0, (a * b) >>> 0, (a * b) ^ 1, (a * b) << 3);

// The same products with literal operands, which the compiler sees whole.
console.log((3 * 3002399751580331) | 0, (3 * 3002399751580331) >>> 0);
console.log((-3 * 3002399751580331) | 0, (2 ** 26 * 2 ** 27) | 0);
console.log((94906267 * 94906267) | 0, (94906265 * 94906267) >>> 0);

// A counted loop whose counter multiplies a constant past 2^53.
const step = 1286742750677284;
let h = 0;
for (let k = 5; k < 9; k++) h = (h + ((k * step) | 0)) | 0;
console.log(h);
