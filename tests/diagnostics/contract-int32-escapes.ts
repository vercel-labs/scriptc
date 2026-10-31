// Int32 slots whose writes the program does not show: a parameter of a
// function used as a callback, and a field of instances that reach
// dynamic code.
import type { Int32 } from "@scriptc/types";

function double(x: Int32): Int32 {
  return (x * 2) | 0;
}

class Box {
  size: Int32 = 0;
}

const box = new Box();
const loose: any = box;
loose.size = 0.5;
const pick: (x: number) => number = double;
console.log([1.5, 2].map(pick).join(","), box.size);
