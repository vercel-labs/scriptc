// Number.prototype.toPrecision and toExponential(fractionDigits): the
// exact binary value rounds half up at the requested digit, exponential
// form takes over when the exponent is below -6 or reaches the precision,
// and the non-finite answers come before the digit-range RangeError.
const values = [0, -0, 1, -1, 2.5, -2.5, 0.5, 1.005, 1.45, 123.456, 0.000001234, 0.0000001234, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 123456789012345680000, 0.1, 99.99, 9.995, 1e23, -1234.5678];
for (const v of values) {
  const p = [1, 2, 3, 5, 10, 21].map((d) => v.toPrecision(d));
  const e = [0, 1, 2, 6, 20].map((d) => v.toExponential(d));
  console.log(String(v), p.join(" "), e.join(" "));
}
console.log((123.456).toPrecision(), (123.456).toPrecision(undefined), (1 / 3).toPrecision(100));
console.log((1 / 3).toExponential(100), (2 ** 70).toPrecision(25), (2 ** -30).toExponential(30));
console.log(NaN.toPrecision(200), Infinity.toPrecision(0), (-Infinity).toExponential(-1), NaN.toExponential(101));
console.log((15).toPrecision(1.9), (15).toExponential(1.9), (0.00001).toPrecision(1), (1e-6).toPrecision(2));
for (const bad of [0, 101, -1, Infinity]) {
  try {
    console.log((1).toPrecision(bad));
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
for (const bad of [-1, 101, Infinity]) {
  try {
    console.log((1).toExponential(bad));
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
let n = 0;
for (let i = 1; i < 2000; i++) {
  const x = i / 7 + i * 1e-9;
  if (x.toPrecision(7) !== Number(x.toPrecision(7)).toPrecision(7)) n++;
}
console.log("stable", n);
