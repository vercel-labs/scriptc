// A program whose own hot function uses an `any` value, and which calls an
// untyped npm package: the warning names the function and summarizes the
// package's dynamic-tier code.
import { tally } from "untyped-lib";

function sumAmounts(rows: any): number {
  let total = 0;
  for (const row of rows) total += row.amount;
  return total;
}

const rows = [{ amount: 2 }, { amount: 5 }];
console.log(sumAmounts(rows), tally(["a", "b", "a"]).a);
