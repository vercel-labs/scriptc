// A namespace whose exports are all bindings that never change after
// initialization (the object-copy form the compiler can hand to untyped
// code as a plain object).
export const answer = 42;
export function double(value: number): number {
  return value * 2;
}
