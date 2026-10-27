import { Probe, Lazy } from "./beta.ts";

export { Probe };
export const label = "ready";
export const other = "other";

export function later(): string {
  return `${Lazy.describe()} ${other}`;
}

console.log("alpha body", Probe.result, Lazy.value);
