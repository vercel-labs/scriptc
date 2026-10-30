import { version } from "./core.ts";

export function makeCounter(): () => number {
  let n = 0;
  return () => ++n;
}
const next = makeCounter();
console.log("util body", next(), next());

export const TAG = "~tagged";

export function mark(box: Record<string, boolean>): Record<string, boolean> {
  box[TAG] = true;
  return box;
}

export function kind(): string {
  return typeof TAG;
}

export function describe(): string {
  return `core v${version}`;
}
