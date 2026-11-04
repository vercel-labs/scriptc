// A generic declaration held at one signature compares equal to itself
// through `unknown`, and further calls at other signatures (which do not
// hold the declaration as a second function object) stay compilable.
type Fn = (x: number) => number;
function ident<T>(x: T): T {
  return x;
}
const f: Fn = ident;
const u: unknown = f;
console.log(u === f, u !== f, f(4));
console.log(ident<number>(5), ident("s").toUpperCase());
