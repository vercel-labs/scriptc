// A generic declaration held at two signatures, read through `unknown`,
// compares unequal to strings, numbers and booleans whichever instance the
// value holds, as in JavaScript.
type Fn = (x: number) => number;
function ident<T>(x: T): T {
  return x;
}
const a: Fn = ident;
const b: (x: string) => string = ident;
const held: unknown = a;
const label = "ident";
const count = 0;
const flag = true;
console.log(held === label, held !== count, held === flag, label === held);
console.log(held === "ident", held !== 1, false === held);
console.log(a(2), b("s"));
