// A native module that imports bindings from two island packages, uses one
// itself and passes them on under its own export statements.
import { SCALE, Ledger, callCount, tally, tallyLater as later } from "tally-kit";
import describe, { level, raise } from "level-kit";

export function twice(items: readonly string[]): number {
  return tally(items) + tally(items);
}
export { SCALE, Ledger, callCount, tally, later as tallyLater, level, raise };
export { describe as describeLevel };
export default tally;
