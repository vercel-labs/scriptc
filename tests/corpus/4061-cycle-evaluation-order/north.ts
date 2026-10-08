import { east } from "./east.ts";

const lines: string[] = [];
export function log(line: string): number {
  lines.push(line);
  console.log(`[${lines.length}] ${line}`);
  return lines.length;
}
export function north(n: number): string {
  return n <= 0 ? "N" : "n" + east(n - 1);
}
log("north body " + east(2));
