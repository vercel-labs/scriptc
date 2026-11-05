// A function with a typed `this` that only JavaScript calls, with a
// receiver JavaScript holds as a dynamic object.
export type Counter = { count: number };

export function bump(this: Counter, by: number): number {
  this.count += by;
  return this.count;
}
