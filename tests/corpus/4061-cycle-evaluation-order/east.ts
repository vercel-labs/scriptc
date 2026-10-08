import { south } from "./south.ts";

export function east(n: number): string {
  return n <= 0 ? "E" : "e" + south(n - 1);
}
console.log("east body", east(1));
