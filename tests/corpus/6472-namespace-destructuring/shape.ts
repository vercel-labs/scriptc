// A module whose exports have the same names and types as some of
// lib.ts's, so `typeof import("./shape.ts")` accepts lib.ts's namespace.
export const label: string = "shape";

export function add(a: number, b: number): number {
  return a * b;
}
