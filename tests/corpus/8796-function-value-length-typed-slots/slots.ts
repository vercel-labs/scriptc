// TypeScript functions written into slots whose signature passes more
// arguments than they declare: each is lowered at its slot's signature and
// keeps its own `length`.
type Three = (a: number, b: number, c: number) => number;
type Two = (a: number, b: number) => number;

export const table: { none: Three; one: Three; two: Three; all: Three } = {
  none: () => 0,
  one: (a) => a,
  two: (a, b) => a + b,
  all: (a, b, c) => a + b + c,
};

export const direct: Two = (a) => a;

export function declared(a: number, b: number, c: number): number {
  return a + b + c;
}

let assigned: Three = (a, b, c) => a + b + c;
assigned = (a) => a;
export const current = (): Three => assigned;

export function give(first: boolean): Three {
  return first ? (a) => a : (a, b) => a + b;
}
