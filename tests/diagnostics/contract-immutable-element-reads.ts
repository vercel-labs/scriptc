// An element read out of an Immutable array is Immutable only when the
// element type can hold an object: a number element of an Immutable array
// is a plain value, while an object element (or an element that is itself
// an array) read into dynamic code stays refused.
import type { Immutable } from "@scriptc/types";

type Row = { n: number };

class Tables {
  nums: Immutable<number[]> = [1, 2, 3];
  rows: Immutable<Row[]> = [{ n: 1 }];
  grid: Immutable<number[][]> = [[1]];
}

const t = new Tables();

const plain: unknown = t.nums[0];
const row: unknown = t.rows[0];
const nested: unknown = t.grid[0];
console.log(plain, row, nested);
