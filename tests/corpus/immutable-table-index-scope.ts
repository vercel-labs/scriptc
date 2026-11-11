// Reading a row out of an Immutable table must not make every array of the
// same type count as possibly Immutable. `a[i]` lowers to one checked element
// read per element type, shared by every call site, and merging the results
// of those calls made a plain array refuse `.map` with a callback once an
// Immutable table of that type was indexed anywhere in the program.
import type { Immutable } from "@scriptc/types";

function sumRows(rows: Immutable<number[][]>): number {
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const found = rows[i];
    if (found !== undefined) total += found[0] + found[1];
  }
  return total;
}

function tableTotal(): number {
  const ROWS: Immutable<number[][]> = [
    [1, 2],
    [3, 4],
  ];
  return sumRows(ROWS);
}

const NAMES: number[][] = [
  [10, 11],
  [12, 13],
];

const FIRSTS = NAMES.map((row) => row[0]);
const PICKED: number[][] = [NAMES[0]!];

function rowSum(i: number): number {
  const found = NAMES[i];
  return found === undefined ? 0 : found[0] + found[1];
}

const TRIMMED = NAMES.filter((row) => row[0] > 10);

let total = 0;
for (let i = 0; i < 2; i++) total += rowSum(i);

console.log(FIRSTS.join(","), TRIMMED.length, total, tableTotal());
