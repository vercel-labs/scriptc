// Row sums whose inner loop runs two columns per step: even, odd, zero, one
// and two columns, column ranges that start above zero or at or past their
// end, fractional, negative, NaN and very large column bounds, a column
// bound read from an array's length, terms that read two elements per
// column, row bounds at and past 2^25, and row and column starts of -0
// with terms that tell -0 from +0. Every sum adds its columns in order,
// so each has the bits of the loop as written.
function rows(u: Float64Array, v: Float64Array, start: number, end: number, from: number, to: number): void {
  for (let i = start; i < end; i++) {
    let t = 0;
    for (let j = from; j < to; j++) t += u[j]! / ((((i + j) * (i + j + 1)) >>> 1) + i + 1);
    v[i] = t;
  }
}

function pairs(u: Float64Array, w: Float32Array, v: Float64Array, end: number): void {
  for (let i = 0; i < end; i++) {
    let t = -0.25;
    for (let j = 0; j < u.length; j++) t += u[j]! * w[j + 1]! - (i + 1) / (j + 3);
    v[i] = t;
  }
}

// 1 / (i * 4 - j) is -Infinity at a -0 row and +0 column, and
// 1 / (j - i * 4) at a -0 column and +0 row: the first pass sees the sign.
function signs(v: Float64Array, start: number, end: number, from: number, to: number): void {
  for (let i = start; i < end; i++) {
    let t = 0;
    for (let j = from; j < to; j++) t += 1 / (i * 4 - j) + 1 / (j - i * 4) + 1 / (i * 4 + j + 1);
    v[i] = t;
  }
}

const show = (label: string, v: Float64Array): void => {
  const parts: string[] = [];
  for (const x of v) parts.push(Object.is(x, -0) ? "-0" : x.toPrecision(17));
  console.log(label, parts.join(" "));
};

const n = 9;
const u = new Float64Array(n).map((_, k) => 1 / (k + 1) + k);
for (const [from, to] of [
  [0, n],
  [0, n - 1],
  [0, 0],
  [0, 1],
  [0, 2],
  [3, n],
  [4, n],
  [5, 5],
  [7, 2],
  [0.5, 6],
  [0, 6.5],
  [-2, 5],
  [-0, 4],
  [NaN, 4],
  [0, NaN],
  [0, n + 3],
  [2 ** 25, 2 ** 25 + 3],
]) {
  const v = new Float64Array(6);
  rows(u, v, 0, 6, from!, to!);
  show(`columns ${from} ${to}`, v);
}
for (const [start, end] of [
  [2 ** 25 - 3, 2 ** 25 + 1],
  [2 ** 25, 2 ** 25 + 2],
  [1, 6],
]) {
  const v = new Float64Array(8);
  rows(u, v, start!, end!, 0, n);
  show(`rows ${start} ${end}`, v);
}

const w = new Float32Array(n + 1).map((_, k) => (k % 4) - 1.5);
for (const end of [0, 1, 4, 5]) {
  const v = new Float64Array(5);
  pairs(u, w, v, end);
  show(`two reads ${end}`, v);
}
const short = new Float64Array(4).map((_, k) => k * 2.5);
const out = new Float64Array(5);
pairs(short, w, out, 5);
show("two reads short", out);
for (const [start, from] of [
  [0, 0],
  [-0, 0],
  [0, -0],
  [-0, -0],
]) {
  const v = new Float64Array(4);
  signs(v, start!, 4, from!, 5);
  show(`signs ${Object.is(start, -0) ? "-0" : start} ${Object.is(from, -0) ? "-0" : from}`, v);
}
