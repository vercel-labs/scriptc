function seven(value: number): number { return value % 7; }
function negative(value: number): number { return value % -7; }
function one(value: number): number { return value % -1; }
const values = [0, -0, 1, -1, 7, -7, 8, -8, 21, -21, 1.5, -1.5, NaN, Infinity, -Infinity, 2147483647, -2147483648, 2147483648, -2147483649, Number.MAX_SAFE_INTEGER];
for (const value of values) {
  for (const result of [seven(value), negative(value), one(value)]) {
    console.log(result, Object.is(result, -0), Number.isNaN(result));
  }
}
let sum = 0;
for (let i = -100; i < 100; i++) sum += seven(i);
console.log(sum);
for (let i = -8; i <= 8; i++) {
  const value = i | 0;
  for (const result of [value % 7, value % -7, value % -1])
    console.log(value, result, Object.is(result, -0));
  const divisor = (i % 3) | 0;
  const uncertain = value % divisor;
  console.log(uncertain, Object.is(uncertain, -0), Number.isNaN(uncertain));
}
