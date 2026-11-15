console.log("modes evaluated");
export const enum Mode {
  Fast = "fast",
  Slow = "slow",
}
export function describe(mode: Mode): string {
  return `mode=${mode}`;
}
