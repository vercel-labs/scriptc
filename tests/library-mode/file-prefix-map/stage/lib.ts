// A staged copy: debug info and stack frames name src/ instead of stage/.
import { sum } from "./math.ts";

export function add(a: number, b: number): number {
  return sum(a, b);
}

export function trace(): string {
  return new Error("traced").stack ?? "";
}
