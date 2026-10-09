/* oxlint-disable no-loss-of-precision -- Oracle inputs intentionally exercise numeric literal rounding. */
// Generates Number.prototype.toFixed test cases with Node as the oracle.
// Each line: <16 hex digits of the double's bit pattern>\t<fractionDigits>\t<x.toFixed(f)>
// Only finite |x| < 1e21 (the scr_f64_to_fixed domain; larger values and
// non-finite receivers fall back to ToString before digit generation).
//
//   node gen-fixed-cases.mjs cases          # curated + seeded cases → stdout
//   node gen-fixed-cases.mjs fuzz <count>   # <count> random cases → stdout
import { argv, stdout } from "node:process";

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

function line(x, f) {
  f64[0] = x;
  return `${u64[0].toString(16).padStart(16, "0")}\t${f}\t${x.toFixed(f)}\n`;
}

function* curated() {
  const values = [
    0,
    -0,
    1,
    -1,
    0.5,
    -0.5,
    1.5,
    2.5,
    -2.5,
    0.05,
    0.005,
    0.0005,
    1.005,
    1.015,
    1.025,
    1.045,
    2.675,
    8.345,
    0.285,
    10.235,
    0.1 + 0.2,
    123.456,
    99.995,
    999.995,
    0.000001,
    1e-7,
    5e-324,
    -5e-324,
    2.2250738585072014e-308,
    Number.EPSILON,
    2 ** 52,
    2 ** 52 + 0.5,
    2 ** 53,
    2 ** 53 + 2,
    2 ** 63,
    2 ** 64,
    2 ** 64 - 2048,
    1.8446744073709552e19,
    1e17,
    1e18,
    1e19,
    1e20,
    999999999999999900000,
    123456789.987654321,
    Math.PI,
    Math.E,
    -Math.PI,
    1 / 3,
    2 / 3,
  ];
  const digits = [0, 1, 2, 3, 5, 10, 15, 17, 20, 21, 22, 23, 25, 30, 50, 99, 100];
  for (const x of values) for (const f of digits) yield [x, f];
  // Where the 64-bit fast path stops: n = |x| × 10^f just below / above 2^64.
  for (let f = 0; f <= 23; f++) {
    for (const scale of [0.5, 0.9, 1, 1.1, 2]) {
      const x = (2 ** 64 / 10 ** f) * scale;
      if (x < 1e21) {
        yield [x, f];
        yield [-x, f];
      }
    }
  }
  // Money-like values and exact halves at small digit counts.
  for (let m = 0; m <= 2000; m++) {
    yield [m / 100, 2];
    yield [m / 1000, 2];
    if (m % 7 === 0) yield [-m / 100, 1];
    if (m % 5 === 0) yield [m / 8, 2];
  }
}

// xorshift128 — deterministic so the committed file is reproducible
function makeRng(seed) {
  let s0 = seed ^ 0x9e3779b97f4a7c15n,
    s1 = 0x2545f4914f6cdd1dn;
  return () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & 0xffffffffffffffffn;
    s1 = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (s1 + y) & 0xffffffffffffffffn;
  };
}

function* random(count, seed) {
  const next = makeRng(seed);
  const int = (n) => Number(next() % BigInt(n));
  let emitted = 0;
  while (emitted < count) {
    const shape = int(4);
    let x;
    let f;
    if (shape === 0) {
      // Raw random bit patterns (mostly tiny or huge) at any precision.
      u64[0] = next();
      x = f64[0];
      f = int(101);
    } else if (shape === 1) {
      // Random magnitudes across the fast-path range.
      x = (int(2 ** 30) / 2 ** 30) * 10 ** (int(30) - 8);
      f = int(26);
    } else if (shape === 2) {
      // Money-like m / 100 and m / 1000 with typical digit counts.
      x = int(10 ** (1 + int(14))) / (int(2) ? 100 : 1000);
      f = int(5);
    } else {
      // Arithmetic results (revenue-style products) with small f.
      x = (int(100000) / 100) * int(50) * (1 - int(300) / 1000);
      f = int(4);
    }
    if (int(3) === 0) x = -x;
    if (!Number.isFinite(x) || Math.abs(x) >= 1e21) continue;
    yield [x, f];
    emitted++;
  }
}

const mode = argv[2] ?? "cases";
let chunk = "";
function emit([x, f]) {
  chunk += line(x, f);
  if (chunk.length > 1 << 16) {
    stdout.write(chunk);
    chunk = "";
  }
}

if (mode === "cases") {
  for (const c of curated()) emit(c);
  for (const c of random(30_000, 0xf1c3dn)) emit(c);
} else if (mode === "fuzz") {
  const count = Number(argv[3] ?? 1_000_000);
  const seed = BigInt(Date.now());
  for (const c of random(count, seed)) emit(c);
} else {
  throw new Error(`unknown mode: ${mode}`);
}
stdout.write(chunk);
