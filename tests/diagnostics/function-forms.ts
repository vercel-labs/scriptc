// Overload signatures compile now (they lower to nothing; calls flow
// through the implementation's ABI — corpus 1850/1851); kept here as
// working context for the fences below.
function overloaded(a: number): number;
function overloaded(a: string): string;
function overloaded(a: number | string): number | string {
  return a;
}
// Type-parameter defaults compile now (bindings fill from the mapped
// default — corpus 1950); kept as working context for the fences below.
function defaulted_tp<T = number>(x: T): T {
  return x;
}
console.log(defaulted_tp(1));
// Optional/default/rest parameters compile for direct calls. Typed rest
// functions are first-class values too; the remaining fence below is for a
// nested defaulted declaration with no contextual completed signature.
function optional(a?: number): number {
  return a === undefined ? 0 : a;
}
function defaulted(a: number = 1): number {
  return a;
}
function rest(...args: number[]): number {
  return args.length;
}
// Optional/defaulted functions as values compile when the inferred binding
// spells the completed `T | undefined` signature (corpus 1535); typed rest
// signatures carry a packed-array ABI (corpus 2917).
const restRef = rest;
// Union-typed parameter defaults compile now (corpus 1535); kept here as
// working context for the fences below.
function unionDefault(x: string | null = "hi"): void {
  console.log(x === null);
}
// Nested function declarations are values (const name = lambda) — fenced.
function outer(): number {
  function inner(n = 2): number {
    return n;
  }
  return inner(1) + inner();
}
// Spread into a REST parameter lowers (the pack copies the spread's
// elements); the fences that remain live in spread-fences.ts.
const pair = [1, 2];
console.log(rest(...pair));
unionDefault();
console.log(optional(1), defaulted(), rest(1, 2), outer());

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
overloaded(1);
defaulted_tp(1);
