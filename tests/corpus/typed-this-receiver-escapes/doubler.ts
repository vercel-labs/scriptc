// A function with a typed `this` that reexport.ts re-exports, and main.mjs
// reaches through that module's exports taken as a whole.
export type Amount = { value: number };

export function double(this: Amount): number {
  this.value *= 2;
  return this.value;
}
