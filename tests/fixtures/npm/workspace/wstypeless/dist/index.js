import { suffix } from "./suffix.js";

export function describe(n) {
  return `typeless:${n * 2}${suffix}`;
}
