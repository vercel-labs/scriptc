import { score } from "./rules.ts";
import { Access } from "./flags.ts";
console.log("limits: start", Access.Write);
export function base(): number {
  return Access.Write;
}
export function total(): number {
  return score();
}
console.log("limits: end");
