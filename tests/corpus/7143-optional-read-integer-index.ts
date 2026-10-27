// Element reads that may be undefined, at indices with a proven integer
// range: loop counters with an unknown limit, `i | 0`, `x >>> 0`, negative
// counters, -0, indices past the length and the capacity, and copies
// `a[x] = b[y]!` that meet holes.
function copy(src: number[], n: number): number[] {
  const out: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = src[i]!;
  return out;
}
const src: number[] = [1, 2, 3, 4];
const copied = copy(src, 6);
console.log(copied.length, copied.join(","), 4 in copied, copied[5] === undefined);

const holes: number[] = new Array<number>(5);
holes[0] = 10;
holes[3] = 13;
const fromHoles = copy(holes, 5);
console.log(fromHoles.join(","), 1 in fromHoles, 3 in fromHoles);

function show(a: (string | undefined)[], from: number, to: number): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const v = a[i];
    out.push(v === undefined ? "_" : v);
  }
  return out.join(",");
}
const words: (string | undefined)[] = ["a", undefined, "c"];
words[5] = "f";
console.log(show(words, -3, 8));
console.log(show(words, 0, 0), show(words, 2, 1));

function masked(a: number[], keys: number[]): string {
  const out: string[] = [];
  for (const k of keys) {
    const v = a[k | 0];
    const w = a[k >>> 0];
    out.push(`${v === undefined ? "-" : v}/${w === undefined ? "-" : w}`);
  }
  return out.join(" ");
}
const values: number[] = [5, 6, 7];
console.log(masked(values, [0, 1.9, 2, 3, -1, -0, 4294967297, 2 ** 31]));

const negativeZero = -0;
console.log(values[negativeZero], values[0 * -1], Object.is(negativeZero, -0));

// A counter that starts below zero and one that passes the capacity.
let total = 0;
for (let i = -2; i < values.length + 3; i++) total += values[i] ?? 100;
console.log(total);
const big: number[] = [];
for (let k = 0; k < 20; k++) big.push(k);
big.length = 10;
let seen = 0;
for (let i = 0; i < 40; i++) if (big[i] !== undefined) seen++;
console.log(seen, big.length);

// Rotations through the read, with a hole that becomes undefined.
function rotate(p: number[], r: number): void {
  const first = p[0]!;
  for (let i = 0; i < r; i++) p[i] = p[i + 1]!;
  p[r] = first;
}
const ring: number[] = new Array<number>(4);
ring[0] = 0;
ring[1] = 1;
ring[3] = 3;
rotate(ring, 3);
console.log(ring.join(","), 1 in ring, ring[1] === undefined);
