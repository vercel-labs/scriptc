import { north } from "./north.ts";

export function south(n: number): string {
  return n <= 0 ? "S" : "s" + north(n - 1);
}
console.log("south body", south(0), typeof north);
