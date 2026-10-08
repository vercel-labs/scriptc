import { isEven } from "./even.ts";

export function isOdd(n: number): boolean {
  return n === 0 ? false : isEven(n - 1);
}
console.log("odd body", typeof isEven, isOdd(1));
