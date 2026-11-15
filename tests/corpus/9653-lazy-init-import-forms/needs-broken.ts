import { MISSING } from "./broken.ts";
import { id } from "./ids.ts";

// Only computes, behind an import that throws: its statements never run,
// and every load of it fails with the error of that import.
export const CUBES: number[] = [];
for (let i = 0; i < 40; i++) CUBES.push(i * i * i);
export const DRAWN: number = id("needs-broken");
export function missing(): string {
  return MISSING;
}
