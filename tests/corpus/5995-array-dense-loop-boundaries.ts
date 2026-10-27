// Index loops whose array length the loop never changes, run over dense,
// holey, partially filled, aliased and short arrays, with fractional,
// negative and offset bounds, ascending, strided and descending counters.

interface Point {
  x: number;
  y: number;
}

function sum(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

function scale(a: number[], b: number[]): string {
  for (let i = 0; i < a.length; i++) b[i] = a[i] * 2;
  return `${b.length}:${b.join(",")}`;
}

function inPlace(a: number[]): string {
  for (let i = 0; i < a.length; i++) a[i] = a[i] + 1;
  return a.join(",");
}

function strided(a: number[], step: number): string {
  let s = 0;
  if (step === 2) for (let i = 0; i < a.length; i += 2) s += a[i];
  else for (let i = 1; i < a.length; i += 3) s += a[i];
  return `${s}`;
}

function descending(a: number[]): string {
  const out: number[] = [];
  for (let i = a.length - 1; i >= 0; i--) out.push(a[i]);
  return out.join(",");
}

function descendingPairs(a: number[]): number {
  let s = 0;
  for (let i = a.length - 2; i > 0; i -= 2) s += a[i] - a[i + 1];
  return s;
}

function offsetBounds(a: number[]): string {
  let inner = 0;
  for (let i = 1; i < a.length - 1; i++) inner += a[i];
  let inclusive = 0;
  for (let i = 0; i <= a.length - 1; i++) inclusive += a[i];
  let diffs = 0;
  for (let i = 0; i < a.length - 1; i++) diffs += a[i + 1] - a[i];
  return `${inner} ${inclusive} ${diffs}`;
}

function fractionalBounds(a: number[]): string {
  const seen: number[] = [];
  for (let i = 0.5; i < a.length; i++) seen.push(a[i] === undefined ? -1 : 1);
  for (let i = -2; i < a.length - 3; i++) seen.push(a[i] === undefined ? -2 : a[i]);
  for (let i = 0; i < a.length - 0.5; i++) seen.push(i);
  return seen.join(",");
}

function whileLoop(a: number[]): number {
  let i = 0;
  let s = 0;
  while (i < a.length) {
    s += a[i] * i;
    i++;
  }
  return s;
}

function constLength(a: number[]): number {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return s;
}

function points(ps: Point[]): string {
  let s = 0;
  for (let i = 0; i < ps.length; i++) s += ps[i].x * ps[i].y;
  return `${s}`;
}

function flags(bs: boolean[]): number {
  let n = 0;
  for (let i = 0; i < bs.length; i++) if (bs[i]) n++;
  return n;
}

function names(ss: string[]): string {
  let out = "";
  for (let i = ss.length - 1; i >= 0; i--) out += ss[i];
  return out;
}

function maybe(xs: (number | undefined)[]): string {
  let s = 0;
  let missing = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v === undefined) missing++;
    else s += v;
  }
  return `${s} ${missing}`;
}

function nested(g: number[][]): number {
  let s = 0;
  for (let r = 0; r < g.length; r++) {
    const row = g[r];
    for (let c = 0; c < row.length; c++) s += row[c] * (r + 1);
  }
  return s;
}

function counterAsNumber(a: number[]): string {
  let mixed = 0;
  for (let i = 0; i < a.length; i++) mixed += i / 2 + (i | 0) + a[i] * -0;
  return `${mixed} ${Object.is(mixed, -0)}`;
}

function earlyExit(a: number[], target: number): number {
  for (let i = 0; i < a.length; i++) if (a[i] === target) return i;
  return -1;
}

const dense = [1, 2, 3, 4, 5, 6, 7, 8];
console.log(sum(dense), sum([]), sum([0.5, -0.25]));
console.log(scale(dense, new Array<number>(8).fill(0)));
console.log(scale(dense, [9, 9]));
console.log(scale([1, 2, 3], []));
const self = [1, 2, 3, 4];
console.log(scale(self, self));
console.log(inPlace([10, 20, 30]));
console.log(strided(dense, 2), strided(dense, 3));
console.log(descending(dense), descending([]));
console.log(descendingPairs(dense), descendingPairs([1]));
console.log(offsetBounds(dense), offsetBounds([4]), offsetBounds([]));
console.log(fractionalBounds([1, 2, 3, 4, 5]));
console.log(whileLoop(dense));
console.log(constLength(dense));
console.log(points([{ x: 1, y: 2 }, { x: 3, y: 4 }]));
console.log(flags([true, false, true, true]));
console.log(names(["a", "b", "c"]));
console.log(maybe([1, undefined, 3]));
console.log(nested([[1, 2], [3], [], [4, 5, 6]]));
console.log(counterAsNumber([1, 2, 3]));
console.log(earlyExit(dense, 5), earlyExit(dense, 50));

// Holes and partially filled storage take the checked path.
const holey = [1];
holey[2] = 3;
holey[4] = 5;
console.log(sum(holey), descending(holey), whileLoop(holey));
const target = [0, 0, 0];
target[4] = 0;
console.log(scale(dense.slice(0, 5), target));
const gap: number[] = [];
gap[3] = 1;
console.log(sum(gap), scale([1, 2, 3, 4], gap));
const shortened = [1, 2, 3, 4, 5, 6];
shortened.length = 3;
shortened.length = 6;
console.log(sum(shortened), constLength(shortened));
const holeyPoints: Point[] = [{ x: 1, y: 1 }];
holeyPoints[2] = { x: 2, y: 2 };
try {
  console.log(points(holeyPoints));
} catch (e) {
  console.log(e instanceof TypeError ? "TypeError" : "other");
}
