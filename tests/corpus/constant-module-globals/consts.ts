export const SLASH = 0x2f;
export const DOT = 0x2e;
export const NEGATIVE = -1;
export const HALF = 0.5;
export const ENABLED = true;
export const MINUS_ZERO = -0;
export let counter = 0;
export function bump(): number {
  return ++counter;
}
