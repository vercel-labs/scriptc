// Number <-> string fast paths, pinned against Node both ways: short
// decimal spellings through Number(), unary plus, and parseFloat (the
// exact Clinger path and its strtod fallback at the 2^53 / 10^22 edges),
// toFixed on money values, exact halves, and the 2^64 fast-path limit, and
// shortest String()/template/JSON output for two-decimal values on both
// sides of the 2^46 cutoff.
const spellings: string[] = [
  "0", "-0", "+0", "00", "0.0", "-0.00", "0e999", "-0e-999", ".5", "5.", "-.25",
  "1", "42", "-17", "199", "12.34", "-12.34", "0.07", "0.1", "0.3", "123.4500", "007.25",
  "1e22", "1e23", "1e-22", "1e-23", "9e37", "123e30", "1.5e-7", "2.5E+3",
  "9007199254740991", "9007199254740992", "9007199254740993", "9007199254740993e2",
  "4503599627370497e22", "1234567890123456789", "12345678901234567890",
  "0.1234567890123456789", "1.000000000000000000001", " 12.5 ", "\t-3.75\n",
  "12px", "1e", "1.2.3", "Infinity", "-Infinity", "0x1f", "0b101", "-0x10",
];
for (let i = 0; i < spellings.length; i++) {
  const s = spellings[i]!;
  const n = Number(s);
  const u = +s;
  const f = parseFloat(s);
  // 1/x distinguishes -0 from +0.
  console.log(JSON.stringify(s), n, 1 / n, Object.is(u, n), f, 1 / f);
}

// toFixed: money values, exact halves (ties up on the exact binary value),
// the 2^64 boundary of the 64-bit fast path, and the bignum fallback.
const fixedInputs: number[] = [
  0, -0, 0.5, 1.5, 2.5, -2.5, 0.005, 1.005, 1.015, 2.675, 8.345, 10.235, 99.995,
  0.1 + 0.2, 123.456, 5e-324, 1e-7, 2 ** 53, 2 ** 64, 2 ** 64 - 2048, 1e19, 1e20,
  184467440737.09552, 18446744073.709552, -18446744073709.552, Math.PI, 1 / 3,
];
for (const x of fixedInputs) {
  console.log(x.toFixed(0), x.toFixed(2), x.toFixed(3), x.toFixed(10), x.toFixed(22), x.toFixed(23));
}
console.log((1.005).toFixed(50));
console.log((5e-324).toFixed(100));

// Shortest output for money-like doubles: m / 100 spellings, values one
// ulp away, arithmetic results that are not exactly m / 100, and the 2^46
// cutoff where the two-decimal path hands over to Ryu.
const cutoff = 2 ** 46;
const shortest: number[] = [
  0.01, 0.05, 0.1, 0.5, 0.99, 1.01, 12.34, 99.99, 100.01, 1.005, 0.285,
  0.1 + 0.2, 0.7 + 0.1, 1.1 * 1.1, 4.35 * 100, 19.99 * 3, 1 / 100,
  cutoff - 1.25, cutoff - 0.75, cutoff - 0.5, cutoff + 0.25, cutoff + 0.5, cutoff * 2 + 0.5,
  70368744177663.99, 70368744177663.01, 9007199254740.99, 900719925474.09,
];
let total = 0;
for (let m = 1; m < 400; m += 7) {
  const x = m / 100;
  shortest.push(x, -x, x + 1e9, (x * 3) / 7);
  total += x;
}
shortest.push(total);
for (const x of shortest) {
  console.log(String(x), `${-x}`, JSON.stringify({ x }), [x, x * 10].join("|"));
}

// The same conversions in the CSV-like shape the benchmarks use.
let revenue = 0;
const rows = ["3,19.99,0.15", "10,0.07,0", "1,1234.5,0.3", "7,2.675,0.125"];
for (const row of rows) {
  const cols = row.split(",");
  const count = Number(cols[0]);
  const price = Number(cols[1]);
  const discount = Number(cols[2]);
  const line = count * price * (1 - discount);
  revenue += line;
  console.log(line.toFixed(2) + "|" + String(count), `${price}`, JSON.stringify([price, discount]));
}
console.log(revenue.toFixed(2), String(Math.round(revenue * 100) / 100));
