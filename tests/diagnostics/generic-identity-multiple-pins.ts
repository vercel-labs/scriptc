// The program holds `ident` at two signatures and compares a value of one
// against the declaration by identity. JavaScript has one function object;
// the compiled program has one closure per signature, so the comparison is
// refused rather than answered `false`.
type Fn = (x: number) => number;
function ident<T>(x: T): T {
  return x;
}
const num: Fn = ident;
const str: (x: string) => string = ident;
console.log(num === ident, str("a"));
