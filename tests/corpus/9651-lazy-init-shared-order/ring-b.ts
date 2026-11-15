import { describeA } from "./ring-a.ts";

export const SIZE_B: number = [1, 2, 3].reduce((sum, n) => sum + n, 0);
export function describeB(): string {
  return "b" + SIZE_B;
}
export function viaA(): string {
  return describeA();
}
