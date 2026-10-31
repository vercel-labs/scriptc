// One generic declaration held at two signatures compares unequal through
// `unknown` today (one closure per signature, one function object in
// JavaScript). Refuse it instead of answering silently wrong.
type Fn = (x: number) => number;
function ident<T>(x: T): T {
  return x;
}
const a: Fn = ident;
const b: (x: string) => string = ident;
const ua = a as unknown;
const ub = b as unknown;
console.log(ua === ub);
