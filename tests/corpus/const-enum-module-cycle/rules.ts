import { Access, owner } from "./flags.ts";
import { base } from "./limits.ts";
console.log("rules: start", owner);
const mask = Access.Read | Access.Exec;
export function score(): number {
  return mask + base();
}
console.log("rules: end", mask);
