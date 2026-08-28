// The STATIC scalar Math members: min/max at two arguments (the ECMA
// folds — NaN poisons, max prefers +0 over -0, min the reverse) and
// random() (uniform [0,1); SEMANTICS.md 62 — Node's distribution, not
// its sequence, so the corpus pins invariants, never bytes). No @dynamic:
// this whole program compiles statically.
console.log(Math.min(2, -9), Math.max(2, -9), Math.min(1.5, 1.5), Math.max(-3, -3));
console.log(Math.min(Infinity, 7), Math.max(-Infinity, 7), Math.min(-Infinity, Infinity));
const pi = Math.PI;
const e = Math.E;
console.log(pi.toFixed(12), e.toFixed(12), (pi + e).toFixed(12), (pi * e).toFixed(12));
const nan = 0 / 0; // NaN-as-a-value stays fenced; the arithmetic form compiles
console.log(Math.min(nan, 1), Math.max(1, nan), Math.min(nan, nan));
// ±0: detect the sign through division (String(-0) is "0" either way).
console.log(1 / Math.min(0, -0), 1 / Math.max(-0, 0));
console.log(1 / Math.min(-0, -0), 1 / Math.max(0, 0));
// Composed through expressions and locals like any number.
let delay = 100;
delay = Math.min(delay * 2, 150);
console.log(delay, Math.max(0, delay - 200));

// Math.random: range, granularity, and type invariants over many draws.
let ok = true;
let low = 2;
let high = -1;
for (let i = 0; i < 500; i = i + 1) {
  const r = Math.random();
  if (!(r >= 0 && r < 1) || Math.floor(r) !== 0) ok = false;
  if (r < low) low = r;
  if (r > high) high = r;
}
// 500 uniform draws land in both halves with probability 1 - 2^-499.
console.log(ok, low < 0.5, high >= 0.5, low !== high);
const a = Math.random();
const b = Math.random();
console.log(typeof a, a === b);

{
  const Math = { PI: 4, E: 3 };
  console.log(Math.PI, Math.E);
}
