import { total } from "./ledger.ts";

console.log("rules body");
export function validate(entries: number[]): number {
  let sum = 0;
  for (const e of entries) {
    if (e < 0) throw new RangeError(`negative entry ${e}`);
    sum += e;
  }
  return sum + total;
}
