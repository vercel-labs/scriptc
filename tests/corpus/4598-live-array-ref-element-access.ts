// A static array passed where a dynamically typed array is expected travels
// as a live reference: element reads, length, writes, presence, iteration,
// and push/pop/at act on the original array, and changes made through
// either view are visible through the other. The 100k-element loops pin
// that each access costs one element rather than a copy of the array.

type Slot = object | undefined;
type Loose = any[];

const N = 100_000;

function sumByIndex(xs: Slot[]): number {
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += xs[i] as unknown as number;
  return total;
}
function scale(xs: Loose, factor: number): void {
  for (let i = 0; i < xs.length; i++) xs[i] = (xs[i] as number) * factor;
}
function countPresent(xs: Slot[]): number {
  let present = 0;
  for (let i = 0; i < xs.length; i++) if (i in xs && Object.hasOwn(xs, i)) present++;
  return present;
}
function sumByIteration(xs: Slot[]): number {
  let total = 0;
  for (const value of xs) total += value as unknown as number;
  return total;
}
function churn(xs: Loose, count: number): number {
  for (let i = 0; i < count; i++) xs.push(i);
  let total = 0;
  for (let i = 0; i < count; i++) total += (xs.at(-1 - i) as number) - (xs.at(i) as number);
  for (let i = 0; i < count; i++) total += xs.pop() as number;
  return total;
}
function writeThrough(xs: Slot[], index: number, value: unknown): void {
  (xs as unknown[])[index] = value;
}

// Large live arrays: every loop would take minutes if an access rebuilt
// the whole array.
const big: number[] = [];
for (let i = 0; i < N; i++) big.push(i);
const bigView = big as unknown as Slot[];
console.log("sum", sumByIndex(bigView), sumByIteration(bigView));
scale(big, 2);
console.log("scaled", big[0], big[1], big[N - 1], sumByIndex(bigView));
console.log("present", countPresent(bigView));
console.log("churn", churn(big, N), big.length, big[N - 1]);
big.length = 10;
console.log("truncated", bigView.length, bigView[9], bigView[10]);

const floats = new Float64Array(N);
for (let i = 0; i < N; i++) floats[i] = i / 2;
console.log("typed array", sumByIndex(floats as unknown as Slot[]), sumByIteration(floats as unknown as Slot[]));

interface Point { x: number; y: number }
const many: Point[] = [];
for (let i = 0; i < N; i++) many.push({ x: i, y: -i });
const manyView = many as unknown as Slot[];
let nested = 0;
for (let i = 0; i < manyView.length; i++) {
  const point = manyView[i] as Point;
  point.y = point.x * 2;
  nested += point.x;
}
console.log("nested", nested, many[N - 1]!.y, (manyView[N - 1] as Point).y);

// Reads, length, holes, and out-of-range indexes through the view.
const nums: number[] = [1, 2, 3, 4];
const view = nums as unknown as Slot[];
console.log("len", view.length, "first", view[0], "last", view[view.length - 1], "oob", view[view.length], view[-1 as number]);
console.log("in", 0 in view, view.length in view, "length" in view, Object.hasOwn(view, 3), Object.hasOwn(view, 4));

// Writes are visible both ways.
writeThrough(view, 1, 20);
console.log("native sees", nums[1], nums.length);
nums[2] = 30;
console.log("view sees", view[2], view.length);
nums.push(5);
console.log("view after native push", view.length, view[4]);
writeThrough(view, 5, 6);
console.log("append", nums.length, nums[5]);
writeThrough(view, 8, 9);
console.log("gap", nums.length, JSON.stringify(nums), 6 in nums, 7 in view, Object.hasOwn(view, 7));
console.log("hole reads", view[6], view[7]);
nums.length = 3;
console.log("native truncate", view.length, view[3], JSON.stringify(view));

// Holes in the original array.
const holey: number[] = [1, , 3] as number[];
const holeyView = holey as unknown as Slot[];
console.log("holey", holeyView.length, holeyView[1], 1 in holeyView, holeyView[2]);
writeThrough(holeyView, 1, 2);
console.log("filled", JSON.stringify(holey), 1 in holey);
let holeySum = 0;
const sparse: number[] = [1, , 3] as number[];
for (const value of sparse as unknown as Slot[]) holeySum += value === undefined ? 100 : (value as unknown as number);
console.log("holey iteration", holeySum);

// Strings and booleans.
const words: string[] = ["a", "b"];
const wordsView = words as unknown as Slot[];
writeThrough(wordsView, 0, "z");
(wordsView as unknown as Loose).push("c");
console.log("words", words.join(""), wordsView[1], wordsView.length, (wordsView as unknown as Loose).at(-1));
const flags: boolean[] = [true, false];
const flagsView = flags as unknown as Slot[];
writeThrough(flagsView, 1, true);
console.log("flags", flags[1], flagsView[0], (flagsView as unknown as Loose).pop(), flags.length);

// Nested objects keep identity and liveness both ways.
const points: Point[] = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
const pointsView = points as unknown as Slot[];
const p0 = pointsView[0] as Point;
console.log("nested", p0.x, pointsView[0] === pointsView[0], p0 === pointsView[0], (pointsView[1] as Point).y);
p0.x = 10;
console.log("native nested", points[0]!.x);
points[1]!.y = 40;
console.log("view nested", (pointsView[1] as Point).y);
writeThrough(pointsView, 0, { x: 7, y: 8 });
console.log("replaced", points[0]!.x, (pointsView[0] as Point).y, p0.x);
points[1] = { x: 5, y: 6 };
console.log("native replaced", (pointsView[1] as Point).x);
const maybe: (Point | undefined)[] = [{ x: 1, y: 1 }, undefined];
const maybeView = maybe as unknown as Slot[];
writeThrough(maybeView, 1, { x: 2, y: 2 });
writeThrough(maybeView, 0, undefined);
console.log("optional", maybe[0] === undefined, maybe[1]!.x, maybeView[0], (maybeView[1] as Point).y);

// Nested arrays.
const grid: number[][] = [[1, 2], [3, 4]];
const gridView = grid as unknown as Slot[];
const row = gridView[1] as number[];
row[0] = 30;
console.log("grid", grid[1]![0], (gridView[0] as number[]).length, gridView.length);
grid[0]!.push(99);
console.log("grid push", (gridView[0] as number[])[2], (gridView[0] as number[]).length);

// Iteration sees elements appended during the loop.
const growing: number[] = [1, 2, 3];
let total = 0;
for (const value of growing as unknown as Slot[]) {
  total += value as unknown as number;
  if (total === 1) growing.push(4);
}
console.log("for-of", total);
const keys: string[] = [];
for (const key in growing as unknown as Slot[]) keys.push(key);
console.log("for-in", keys.join(","), JSON.stringify(Object.keys(growing as unknown as Slot[])));
console.log("isArray", Array.isArray(growing as unknown as Slot[]), typeof (growing as unknown as Slot[]));
