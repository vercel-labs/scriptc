// A recursive function over a number array runs as an integer clone.
// sumFrom only receives arrays that hold int32s, which keep 4-byte int32
// slots, and the clone reads them at that width, near their end too.
// sumWide receives an array that also holds a fraction, with 8-byte slots.
function sumFrom(xs: number[], i: number): number {
  if (i >= xs.length) return 0;
  return xs[i]! + sumFrom(xs, i + 1);
}

function masked(n: number, start: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i & 7);
  return sumFrom(a, start);
}

function halves(n: number, start: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i < n / 2 ? 0 : 3);
  return sumFrom(a, start);
}

function sumWide(xs: number[], i: number): number {
  if (i >= xs.length) return 0;
  return xs[i]! + sumWide(xs, i + 1);
}

function widened(n: number, start: number): number {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i % 5);
  const before = sumWide(a, start);
  a.push(0.5);
  return before * 10 + sumWide(a, start);
}

const { n } = JSON.parse('{"n": 1000}') as { n: number };
for (const start of [0, 1, n / 2, n - 9, n - 2, n - 1, n])
  console.log(start, masked(n | 0, start | 0), halves(n | 0, start | 0));
for (const size of [63, 64, 65])
  console.log(size, halves(size, size - 24), halves(size, size - 1), masked(size, size - 3));
console.log(widened(40, 0), widened(40, 37));
