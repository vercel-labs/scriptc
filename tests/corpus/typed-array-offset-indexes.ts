// Typed array reads and writes at `base + c`, `c + base` and `base - c`,
// where `base` is a number that may be an integer, a fraction, negative,
// -0, NaN, infinite or past the length.

function readGroup(values: Float64Array, at: number): number[] {
  return [values[at + 0]!, values[at + 1]!, values[2 + at]!, values[at - 1]!, values[at + 7]!];
}

function writeGroup(values: Int32Array, at: number, value: number): void {
  values[at + 0] = value;
  values[1 + at] = value + 1;
  values[at - 2] = value - 2;
}

function sumWindow(values: Uint8Array, at: number): number {
  return (values[at] ?? 0) + (values[at + 1] ?? 0) + (values[at + 2] ?? 0) + (values[at + 3] ?? 0);
}

const floats = new Float64Array(16);
for (let i = 0; i < floats.length; i++) floats[i] = i * 1.5;
const bases = [0, 1, 4, 8.5, -0, -1, -0.5, 15, 16, 2 ** 31, 2 ** 52, 2 ** 53, -(2 ** 53), NaN, Infinity, -Infinity];
for (const base of bases) console.log(String(base), JSON.stringify(readGroup(floats, base)));

const ints = new Int32Array(8);
for (const base of [2, 3.25, -0, 7, 9, NaN, 2 ** 52 + 1]) {
  writeGroup(ints, base, 10);
  console.log(String(base), ints.join(","));
}

const bytes = new Uint8Array([5, 4, 3, 2, 1, 250, 251, 252]);
let total = 0;
for (let i = 0; i < 8; i++) total += sumWindow(bytes, i);
console.log(total, sumWindow(bytes, 6), sumWindow(bytes, 4.5));

// A base with a fraction too small to survive the sum indexes like the sum.
for (const base of [1e-20, -1e-20, 2 ** -60, 3 + 2 ** -50, 0.5, -0.75]) {
  console.log(String(base), JSON.stringify(readGroup(floats, base)));
  writeGroup(ints, base, 20);
  console.log(String(base), ints.join(","));
}

// A right-hand side that changes the base: the index is the one evaluated
// before it.
function rebase(values: Int32Array, at: number): number {
  values[at + 1] = ((at = 5), 31);
  values[2 + at] = at++;
  values[at - 1] += ((at = 0), 4);
  Atomics.add(values, at + 3, ((at = 6), 2));
  return at;
}
const targets = new Int32Array(10);
console.log(rebase(targets, 2), targets.join(","));
