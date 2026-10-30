// A Date local initialized from an existing Date is another reference to
// the same object: a mutation through the other reference (a JavaScript
// module's setTime) shows through the local. A relational comparison reads
// both operands' times after both operands evaluate, so a right operand
// that mutates the left Date is seen.
import { advance } from "./clock.js";

function aliases(start: Date): string {
  const alias = start;
  advance(start, 60_000);
  const stamp = alias.toISOString();
  const other = new Date(start.getTime() + 1);
  const moved = start < (advance(start, 5), other);
  const after = start <= (advance(start, 10), other);
  return `${stamp} ${alias.getTime() === start.getTime()} ${moved} ${after}`;
}
console.log(aliases(new Date(Date.UTC(2026, 0, 15, 12))));

const fresh = new Date(0);
const copy = new Date(fresh);
advance(fresh, 1000);
console.log(fresh.getTime(), copy.getTime(), fresh < copy, copy < fresh);
