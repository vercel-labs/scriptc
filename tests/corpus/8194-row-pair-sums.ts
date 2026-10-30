// Row sums (`for i { t = 0; for j t += term; out[i] = t }`) over typed
// arrays, run with even and odd row counts, an empty range, fractional,
// negative-zero and out-of-int32 bounds, and output arrays that are the
// input array or overlap it in one buffer, so a row may read an earlier
// row's result.
function rows(u: Float64Array, v: Float64Array, start: number, end: number, n: number): void {
  for (let i = start; i < end; i++) {
    let t = 0;
    for (let j = 0; j < n; j++) t += u[j]! / ((((i + j) * (i + j + 1)) >>> 1) + i + 1);
    v[i] = t;
  }
}

function weighted(u: Float32Array, w: Int32Array, v: Float64Array, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    let t = 0.5;
    for (let j = 0; j < u.length; j++) t += u[j]! * w[(i + j) % w.length]! - i * 0.25;
    v[i] = t;
  }
}

const show = (label: string, v: Float64Array): void => {
  const parts: string[] = [];
  for (const x of v) parts.push(Object.is(x, -0) ? "-0" : x.toPrecision(17));
  console.log(label, parts.join(" "));
};

const n = Number(process.argv[2] ?? 7);
const u = new Float64Array(n).map((_, k) => k + 1);
for (const [start, end] of [
  [0, n],
  [0, n - 1],
  [1, n],
  [2, 2],
  [3, 1],
  [-0, 3],
  [0.5, 4],
  [0, 4.5],
  [2 ** 31 - 3, 2 ** 31 + 1],
  [NaN, 3],
]) {
  const v = new Float64Array(n + 2);
  rows(u, v, start!, end!, n);
  show(`rows ${start} ${end}`, v);
}

// The output is the input: each row reads the rows stored before it.
const same = new Float64Array(n).map((_, k) => k + 1);
rows(same, same, 0, n, n);
show("same", same);

// Overlapping views of one buffer, offset by one element.
const buffer = new ArrayBuffer(8 * (n + 1));
const lo = new Float64Array(buffer, 0, n).map((_, k) => k + 1);
const hi = new Float64Array(buffer, 8, n);
rows(lo, hi, 0, n, n);
show("overlap", new Float64Array(buffer));

// Disjoint views of one buffer.
const shared = new ArrayBuffer(16 * n);
const a = new Float64Array(shared, 0, n).map((_, k) => n - k);
const b = new Float64Array(shared, 8 * n, n);
rows(a, b, 0, n, n);
show("disjoint", b);

const f = new Float32Array(n).map((_, k) => k / 3);
const w = new Int32Array([3, -1, 4, 1, -5]);
const out = new Float64Array(n);
weighted(f, w, out, 0, n);
show("weighted", out);
weighted(f, w, out, 1, n - 1);
show("weighted inner", out);

// Arrays a program assigns only when the row range is nonempty: an empty or
// one-row range never reads them, and the paired copy does not either.
function lazyRows(n: number, start: number, end: number): number {
  let u!: Float64Array;
  let v!: Float64Array;
  if (end > start) {
    u = new Float64Array(n).fill(1);
    v = new Float64Array(end);
  }
  for (let i = start; i < end; i++) {
    let t = 0;
    for (let j = 0; j < n; j++) t += u[j]! / (i + j + 1);
    v[i] = t;
  }
  return end > start ? v[end - 1]! : -1;
}
console.log("lazy", lazyRows(4, 3, 3), lazyRows(4, 2, 3), lazyRows(4, 0, 5), lazyRows(0, 5, 5));
