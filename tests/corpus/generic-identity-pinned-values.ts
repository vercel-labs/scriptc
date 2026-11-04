// Pinning one generic declaration at signatures that unify to ONE instance
// keeps JavaScript's function identity: the return-widening slot binds the
// same type parameter, so `ident` stays one function object and the
// comparison is exact, not refused.
function ident<T>(x: T): T {
  return x;
}
function other<T>(x: T): T {
  return x;
}
const num: (x: number) => number = ident;
const wide: (x: number) => number | string = ident;
const again: (x: number) => number = ident;
const alt: (x: number) => number = other;
const i = ident<number>;
console.log("same-instance", num === wide, num === again, num === i, i === ident<number>);
console.log("other-declaration", num === alt, num !== alt);
