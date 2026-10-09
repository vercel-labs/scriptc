// `%` takes an inline integer path when both operands turn out to be
// integers at run time and keeps the floating remainder for everything
// else. Results must match Node exactly, including the sign of zero, NaN for
// zero divisors and non-finite operands, and integers beyond 2^53.

function show(label: string, v: number): void {
  console.log(label, Object.is(v, -0) ? "-0" : String(v));
}

// Unproven operands: values that flow through arrays, records, and globals.
const dividends: number[] = [
  0, -0, 1, -1, 7, -7, 8, -8, 12, -12, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 2 ** 32 + 5,
  2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 53, -(2 ** 53), 2 ** 53 + 2, -(2 ** 53 + 2), 2 ** 62,
  2 ** 63, -(2 ** 63), 2 ** 64, -(2 ** 64), 1e21, -1e21, 1.5, -1.5, 5.25, -5.25, 1e-300,
  Number.MAX_VALUE, -Number.MAX_VALUE, NaN, Infinity, -Infinity,
];
const divisors: number[] = [
  1, -1, 2, -2, 3, -3, 4, 7, -7, 10, 1000000007, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 53,
  -(2 ** 53), 2 ** 53 + 2, 2 ** 63, -(2 ** 63), 2 ** 64, 0, -0, 0.5, -0.5, 2.5, NaN,
  Infinity, -Infinity, Number.MIN_VALUE,
];
let checksum = 0;
for (let i = 0; i < dividends.length; i++) {
  for (let j = 0; j < divisors.length; j++) {
    const r = dividends[i]! % divisors[j]!;
    show(`${dividends[i]} % ${divisors[j]}`, r);
    if (r === r) checksum = (checksum + Math.abs(r)) % 1000003;
  }
}
show("checksum", checksum);

// Constant divisors with an unproven dividend (the common loop shape).
for (const d of dividends) {
  show(`${d} % 5`, d % 5);
  show(`${d} % -5`, d % -5);
  show(`${d} % 0`, d % 0);
  show(`${d} % 1`, d % 1);
}

// Unproven divisors with a proven integer dividend.
for (let i = -6; i <= 6; i += 3) {
  for (const d of divisors) show(`${i} % ${d}`, i % d);
}

// Proven loop counters with a possibly zero divisor.
for (let i = -3; i <= 3; i++) {
  for (let k = -2; k <= 2; k++) show(`${i} % ${k}`, i % k);
}

// Record fields, compound assignment, and a global accumulator.
interface Ev {
  time: number;
}
const evs: Ev[] = [];
for (let i = -10; i < 30; i++) evs.push({ time: i * 1.5 });
let kept = 0;
for (const e of evs) if (e.time % 5 !== 0) kept++;
console.log("kept", kept);
let acc = 1;
for (let i = 0; i < 50; i++) {
  acc = (acc * 48271 + 11) % 2147483647;
  acc %= 1000003;
}
console.log("acc", acc);
let neg = -100;
neg %= 10;
show("neg %= 10", neg);
let big = 2 ** 60;
big %= 1000;
show("2^60 %= 1000", big);
const parsed = Number("-12") % Number("4");
show("parsed", parsed);
show("1/(-12 % 4)", 1 / parsed);
