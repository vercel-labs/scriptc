export type { Payload } from "./payload.ts";

export type Mode = "fast" | "slow";

export function describe(mode: Mode): string {
  return `mode=${mode}`;
}
console.log("mixed evaluated");
