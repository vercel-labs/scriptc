// A table built when the module loads, and two ways to read it.
function build(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1024; i++) out.push((i * 2654435761) % 1000);
  return out;
}
export const TABLE: number[] = build();
export const SCALE: number = TABLE.length / 512;
export function at(i: number): number {
  return TABLE[i & 1023]! * SCALE;
}
export function sum(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += TABLE[i & 1023]! * SCALE;
  return total;
}
