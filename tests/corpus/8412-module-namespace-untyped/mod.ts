export const alpha = 1;
export let count = 0;
export function beta(): string {
  return "b" + String(count);
}
export function bump(): void {
  count += 1;
}
export const obj = { k: alpha };
export default class Gamma {
  readonly tag = "g";
}
