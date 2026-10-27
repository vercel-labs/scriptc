// `**` answers NaN for a base of ±1 with a NaN or infinite exponent, where
// libm's pow (and LLVM's folding of pow(1, x)) answers 1.
const values = [Infinity, -Infinity, NaN, 0, -0, 2, 0.5];
const read = (i: number): number => values[i % values.length]!;
for (let i = 0; i < values.length; i++) {
  const x = read(i);
  console.log(x, 1 ** x, (-1) ** x, x ** 0, x ** 1, 2 ** x, x ** -1);
}
let base = 1;
let exponent = Infinity;
console.log(base ** exponent, (-base) ** exponent, base ** NaN);
exponent = 3;
console.log(base ** exponent, (-1) ** exponent);
let acc = 1;
acc **= Infinity;
console.log(acc, Math.pow(1, Infinity), NaN ** 0, (-0) ** -1, 0 ** -1);
