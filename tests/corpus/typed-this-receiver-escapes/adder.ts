// A function with a typed `this` that named.ts imports under an export name
// written as a string.
export type Total = { total: number };

export function add(this: Total, amount: number): number {
  this.total += amount;
  return this.total;
}
