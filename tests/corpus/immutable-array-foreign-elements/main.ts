// A checked element read passes its array to the runtime helper that
// rejects a foreign element. That helper always throws, so it cannot keep
// or write the array: iterating an Immutable array is not an escape, even
// when some untyped code elsewhere made array elements dynamic-writable.
import type { Immutable } from "@scriptc/types";
import { assign } from "./app.js";

class Tables {
  nums: Immutable<number[]> = [1, 2, 3];
}

const t = new Tables();
let sum = 0;
for (const n of t.nums) sum += n;

const scratch: number[] = [1, 2, 3];
const dynamic: unknown = scratch;
const target: Record<string, string> = {};
assign(target, { a: "x" });
console.log(target["a"], sum, Array.isArray(dynamic));
