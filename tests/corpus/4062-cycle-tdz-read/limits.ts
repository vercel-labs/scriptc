import { probe, spend, clear } from "./probe.ts";

console.log("before:", probe());
console.log("spend before:", spend(1));
console.log("clear before:", clear());
export const limit: number = 8;
export let used = 0;
export function record(n: number): void {
  used += n;
}
export function reset(): void {
  used = 0;
}
console.log("after:", probe());
console.log("spend after:", spend(3));
export { probe };
