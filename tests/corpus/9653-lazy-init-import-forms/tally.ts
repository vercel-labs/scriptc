// A second counter, drawn from only by first.ts and second.ts.
let next = 100;
export function ticket(): number {
  return next++;
}
