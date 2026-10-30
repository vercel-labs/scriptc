// A typed program passes its arrays to untyped CommonJS functions, which
// read their elements and lengths, write them and resize them. Element reads
// cover integral, negative, fractional, non-finite and out-of-range indexes,
// string keys, holes, frozen arrays and arrays of other element types.
import { createRequire } from "node:module";

interface Lib {
  total(xs: readonly unknown[]): number;
  at(xs: readonly unknown[], i: unknown): unknown;
  describe(xs: readonly unknown[], keys: unknown[]): string;
  has(xs: readonly unknown[], i: number): boolean;
  write(xs: unknown[], i: number, v: unknown): unknown;
  grow(xs: unknown[], v: unknown): number;
  cut(xs: unknown[], n: number): number;
  lengthOf(xs: readonly unknown[]): number;
}
const require = createRequire(import.meta.url);
const lib: Lib = require("./lib.cjs");

// Element reads of a number[] at integral, negative, fractional,
// non-finite and out-of-range indexes, and through string keys.
const nums: number[] = [1, 2.5, -0, NaN, Infinity, -7];
console.log(lib.total([1, 2, 3, 4]), lib.total(nums), lib.total([]));
console.log(lib.describe(nums, [0, 1, 2, 3, 4, 5, 6, -1, 1.5, -0, NaN, Infinity, 2 ** 32, "1", "01", "length"]));
console.log(lib.at(nums, 5), lib.at(nums, 6), typeof lib.at(nums, 2), Object.is(lib.at(nums, 2), -0));

// Holes: below and past the hole-free prefix, and an array cut longer.
const holey: number[] = [1, 2];
holey[4] = 5;
console.log(lib.describe(holey, [0, 1, 2, 3, 4, 5]), lib.has(holey, 3), lib.has(holey, 4), lib.lengthOf(holey));
const longer: number[] = [3, 4, 5];
longer.length = 6;
console.log(lib.describe(longer, [0, 2, 3, 5]), lib.lengthOf(longer));

// Writes from the package and from the program are seen by both.
const live: number[] = [10, 20, 30];
console.log(lib.write(live, 0, 11), lib.write(live, 3, 40), lib.grow(live, 50), live.join(","));
live.push(60);
live[1] = 21;
console.log(lib.total(live), lib.lengthOf(live), lib.at(live, 5));
console.log(lib.cut(live, 2), lib.total(live), live.length, lib.at(live, 2));

// Frozen and empty arrays.
const frozen: readonly number[] = Object.freeze([4, 5, 6]);
console.log(lib.total(frozen), lib.at(frozen, 1), lib.at([], 0), lib.lengthOf([]));

// Arrays of other element types read through the same sites.
const words: string[] = ["a", "b", "c"];
const flags: boolean[] = [true, false];
const points: { x: number }[] = [{ x: 1 }, { x: 2 }];
console.log(lib.describe(words, [0, 2, 3]), lib.describe(flags, [0, 1, 2]), (lib.at(points, 1) as { x: number }).x);
console.log(lib.at(words, 1.5), lib.has(words, 2), lib.lengthOf(points));

// A loop over a larger array.
const big: number[] = [];
for (let i = 0; i < 1000; i++) big.push(i % 7);
let sum = 0;
for (let round = 0; round < 50; round++) sum += lib.total(big);
console.log(sum);
