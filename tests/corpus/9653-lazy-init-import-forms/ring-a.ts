import { sizeB, describeB } from "./ring-b.ts";

// Two modules that import each other, loaded by import().
export const NAMES_A: string[] = [];
for (const name of ["a1", "a2", "a3"]) NAMES_A.push(name + "!");
export function sizeA(): number {
  return NAMES_A.length;
}
export function both(): string {
  return NAMES_A.join("+") + "/" + sizeB() + " " + describeB();
}
