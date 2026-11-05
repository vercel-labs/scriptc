// A function with a typed `this` that main.mjs reaches through the
// module's exports taken as a whole.
export type Tally = { total: number };

export function scale(this: Tally, factor: number): number {
  this.total *= factor;
  return this.total;
}
