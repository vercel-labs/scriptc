import { SHAPES } from "./shapes.ts";

// An initializer that could throw, and here does not.
function total(limit: number): number {
  let sum = 0;
  for (const shape of SHAPES) sum += shape.sides;
  if (sum > limit) throw new RangeError("too many sides: " + sum);
  return sum;
}
export const TOTAL: number = total(100);
