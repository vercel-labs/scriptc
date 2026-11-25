import { sizeA } from "./ring-a.ts";

export const NAMES_B: string[] = [];
for (const name of ["b1", "b2"]) NAMES_B.push(name + "?");
export function sizeB(): number {
  return NAMES_B.length;
}
export function describeB(): string {
  return NAMES_B.join("+") + "/" + sizeA();
}
