// A dev library: its archive carries the .ts lines, as a dev executable's
// binary does, so a native debugger and a stack frame name them.
import { sum } from "./math.ts";

export function add(a: number, b: number): number {
  return sum(a, b);
}
