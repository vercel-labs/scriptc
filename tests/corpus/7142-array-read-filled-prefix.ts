// Element reads that may be undefined (`a[i]` as `T | undefined`, and the
// stores `a[x] = a[y]!` read through) on arrays whose hole-free prefix
// changes: holes from writes past the end and from a longer length, present
// undefined, shrinking and regrowing, shift and unshift, out-of-range and
// negative indices, and reads at a loop counter and at a computed index.
function show(a: (number | undefined)[]): string {
  const out: string[] = [];
  for (let i = -1; i <= a.length; i++) {
    const v = a[i];
    out.push(v === undefined ? (i in a ? "u" : "_") : String(v));
  }
  return out.join(",");
}
const a: (number | undefined)[] = [10, 11, 12, 13, 14, 15];
console.log(show(a));
a[8] = 18;
console.log(show(a), 7 in a);
a.length = 9;
console.log(show(a));
a[7] = 17;
console.log(show(a));
a.length = 3;
console.log(show(a));
a.push(30, 31);
console.log(show(a));
a.unshift(1);
console.log(show(a));
a.shift();
a.shift();
console.log(show(a));
const withUndefined: (number | undefined)[] = [1, undefined, 3];
console.log(show(withUndefined));

// Copies through the read: a hole stores undefined, which `in` then sees.
function rotate(p: number[], r: number): void {
  const first = p[0]!;
  for (let i = 0; i < r; i++) p[i] = p[i + 1]!;
  p[r] = first;
}
const p: number[] = [0, 1, 2, 3, 4];
rotate(p, 4);
console.log(p.join(","));
const holes: number[] = new Array<number>(4);
holes[0] = 0;
holes[1] = 1;
holes[3] = 3;
rotate(holes, 3);
console.log(holes.length, 1 in holes, holes[1] === undefined, holes.join(","));

// Reads at a computed index and at an index beyond the capacity.
function pick(src: number[], idx: number[]): string {
  const out: string[] = [];
  for (const k of idx) {
    const v = src[k * 2];
    out.push(v === undefined ? "-" : String(v));
  }
  return out.join(",");
}
const big: number[] = [];
for (let k = 0; k < 40; k++) big.push(k * k);
console.log(pick(big, [0, 1, 5, 19, 20, 1000, -1, 2 ** 31]));
big.length = 10;
console.log(pick(big, [0, 4, 5, 6]));

// Swaps at two counters, then reads of the swapped array.
const q: number[] = [5, 4, 3, 2, 1, 0];
for (let lo = 0, hi = q.length - 1; lo < hi; lo++, hi--) {
  const t = q[lo]!;
  q[lo] = q[hi]!;
  q[hi] = t;
}
console.log(q.join(","), show(q));
