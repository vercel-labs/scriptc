import { describeB, SIZE_B } from "./ring-b.ts";

export const NAMES_A: string[] = ["a1", "a2"].map((name) => name + "!");
export function describeA(): string {
  return NAMES_A.join("+") + "/" + SIZE_B;
}
export function both(): string {
  return describeA() + " " + describeB();
}
