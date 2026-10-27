// Element reads and writes indexed by products of int32 values plus or
// minus int32 terms. The products can pass the int32 range and 2^53, where
// a double product rounds: an index that lands in an array's range reads
// and writes that element, and every other one (negative, past the length,
// rounded past 2^53) keeps the property key Node computes from the double.

function show(label: string, value: unknown): void {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

function read(a: number[], x: number, y: number, k: number): number | undefined {
  return a[x * y + k];
}

function readBack(a: number[], x: number, y: number, k: number): number | undefined {
  return a[x * y - k];
}

function write(a: number[], x: number, y: number, k: number, v: number): void {
  a[x * y + k] = v;
}

function rows(n: number, cols: number, a: number[]): number {
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < cols; j++) s += a[i * cols + j]! * (j + 1);
  return s;
}

const a: number[] = [];
for (let i = 0; i < 64; i++) a.push(i * 10);

const big = 2147483647;
const half = 65536;

// In range.
show("3*5+2", read(a, 3 | 0, 5 | 0, 2 | 0));
show("7*-1+9", read(a, 7 | 0, -1 | 0, 9 | 0));
show("-0 index", read(a, -1 | 0, 0 | 0, 0 | 0));
// The product passes the int32 range; the difference lands in range.
show("2^16*2^15-2^31+12", readBack(a, half | 0, 32768 | 0, (-2147483648 * -1 - 12) | 0));
show("(2^31-1)*1-(2^31-1)+5", read(a, big | 0, 1 | 0, -2147483642 | 0));
show("2^16*2^16-big+20", readBack(a, half | 0, half | 0, (big - 20) | 0));
// Out of range or negative: holes and named keys.
show("past end", read(a, 8 | 0, 8 | 0, 1 | 0));
show("negative", read(a, -3 | 0, 5 | 0, 0 | 0));
show("2^31*2^31", read(a, -2147483648 | 0, -2147483648 | 0, 7 | 0));

// Products around 2^53, where the double product rounds.
const keys: number[] = [];
const x = 134217727; // 2^27 - 1
const y = 67108865; // 2^26 + 1: x * y = 2^53 + 2^26 - 1
const near: [number, number, number][] = [
  [x, y, 0],
  [x, y, 1],
  [x, y, -67108864],
  [x, y, -67108863],
  [94906265, 94906265, 0],
  [94906267, 94906267, -3],
  [-2147483648, 2147483647, 2147483647],
];
for (const [p, q, k] of near) {
  const sparse: number[] = [];
  write(sparse, p | 0, q | 0, k | 0, 1);
  // The key the double computes; a local holds only the double.
  const key: number = p * q + k;
  keys.push(key);
  show(`write ${p}*${q}+${k}`, `${sparse[key]} ${sparse[key + 1]} ${sparse[key - 1]} ${sparse.length}`);
  show(`read ${p}*${q}+${k}`, read(sparse, p | 0, q | 0, k | 0));
}
show("keys", keys.join(","));

// A difference of two products above 2^53 keeps the double's rounding.
function cancel(sparse: number[], p: number, q: number, r: number, s: number): number | undefined {
  return sparse[p * q - r * s];
}
const cancelled: number[] = [7, 8, 9];
show("cancel", cancel(cancelled, x | 0, y | 0, x | 0, y | 0));
show("cancel+1", cancel(cancelled, x | 0, y | 0, (9007199254740992 / 67108864) | 0, 67108864 | 0));

// Row-major sums with a width from JSON.
const dims = JSON.parse("[[8, 8], [4, 16], [16, 4], [3, 7]]") as [number, number][];
for (const [n, cols] of dims) show(`rows ${n}x${cols}`, rows(n | 0, cols | 0, a));
