import { b } from "./b.ts";

export interface AInfo {
  tag: string;
}

export function start(): string {
  return `a+${b()}`;
}
console.log("a evaluated");
