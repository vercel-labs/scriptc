import { isOdd } from "./odd.ts";

export function isEven(n: number): boolean {
  return n === 0 ? true : isOdd(n - 1);
}
export function parity(n: number): string {
  return `${n} is ${labels[isEven(n) ? 0 : 1]}`;
}
console.log("even body", isEven(4), isOdd(4));
const labels = ["even", "odd"];
console.log("even ready", parity(2));
