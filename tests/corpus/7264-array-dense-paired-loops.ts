// Two-counter loops that index number arrays at both counters
// (`for (let i = lo, j = hi; i < j; i++, j--)`), and element copies through
// `a[i]!` reads, both inside and outside the ranges a single entry test can
// cover: filled prefixes, holes, present undefined, reads past the end,
// fractional and negative starts, int32 arrays and long checked arrays.

function reversePrefix(a: number[], end: number): void {
  for (let i = 0, j = end; i < j; i++, j--) {
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
}

function show(label: string, a: number[]): void {
  console.log(label, a.length, JSON.stringify(a), a);
}

// The whole prefix is present: the entry test passes.
const plain: number[] = [];
for (let k = 0; k < 8; k++) plain[k] = k * 3;
reversePrefix(plain, 5);
show("plain", plain);
reversePrefix(plain, 7);
show("whole", plain);
reversePrefix(plain, 0);
show("empty range", plain);

// The high start is past the end: the reads there miss, the stores extend.
const short = [1, 2, 3];
reversePrefix(short, 5);
show("past the end", short);

// A hole inside the range.
const holey: number[] = [10, 20];
holey[3] = 40;
holey[4] = 50;
reversePrefix(holey, 4);
show("hole", holey);

// A present undefined inside the range, copied by a mirror loop.
const loose: number[] = [7, 8, 9, 10];
(loose as (number | undefined)[])[2] = undefined;
for (let i = 0, j = 3; i < j; i++, j--) loose[i] = loose[j]!;
show("undefined", loose);

// Fractional and negative starts index non-element properties.
const fractional = [1, 2, 3, 4];
reversePrefix(fractional, 2.5);
show("fractional", fractional);
const negative = [5, 6, 7];
for (let i = -1, j = 2; i < j; i++, j--) negative[i] = negative[j]!;
show("negative", negative);

// A local int32 array (every stored element is a small integer).
function int32Flips(start: number): void {
  const counts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  let flips = 0;
  for (let first = counts[start]!; first !== 0; first = counts[0]!) {
    for (let i = 0, j = first; i < j; i++, j--) {
      const t = counts[i]!;
      counts[i] = counts[j]!;
      counts[j] = t;
    }
    flips++;
    if (flips > 20) break;
  }
  console.log("int32", flips, counts.join(","));
}
int32Flips(3);
int32Flips(9);

// A local long array with checked int32 stores, widened by a fraction.
function longChecked(n: number, fraction: number): void {
  const long = new Array<number>(n).fill(0);
  for (let k = 0; k < long.length; k++) long[k] = k;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const t = long[i]!;
    long[i] = long[j]!;
    long[j] = t;
  }
  console.log("long", long[0], long[1], long[n - 2], long[n - 1]);
  long[10] = fraction;
  for (let i = 0, j = 20; i < j; i++, j--) {
    const t = long[i]!;
    long[i] = long[j]!;
    long[j] = t;
  }
  console.log("widened", long.slice(0, 12).join(","), long[20]);
}
longChecked(5000, 0.5);

// Element copies through `a[i]!`: the source is shorter than the range.
function copy(to: number[], from: number[], n: number): void {
  for (let i = 0; i < n; i++) to[i] = from[i]!;
}
const into = [0, 0, 0, 0, 0, 0];
copy(into, [1, 2, 3, 4, 5, 6], 6);
show("copy", into);
copy(into, [9, 8], 4);
show("short source", into);
const gappy: number[] = [1];
gappy[2] = 3;
gappy[3] = 4;
copy(into, gappy, 4);
show("gappy source", into);

// Two names for one array.
function aliased(n: number): void {
  const same: number[] = [];
  for (let k = 0; k < n; k++) same[k] = k + 1;
  const alias = same;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const t = alias[i]!;
    same[i] = alias[j]!;
    same[j] = t;
  }
  show("alias", same);
}
aliased(5);
