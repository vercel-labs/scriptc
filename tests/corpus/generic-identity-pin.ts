// An unpinned generic declaration compared by identity against a held
// function: the comparison pins the instance the other operand's type
// names, so `h.fn === ident` answers as JavaScript does.
type Fn = (x: number) => number;
function ident<T>(x: T): T {
  return x;
}
class Holder {
  fn: Fn = ident;
}
const h = new Holder();
console.log(h.fn === ident, h.fn(3));
h.fn = (x) => x + 1;
console.log(h.fn === ident, h.fn(3), ident !== h.fn);
const fns: Fn[] = [ident, (x) => x * 2];
console.log(fns.map((f) => (f === ident ? "ident" : "other")).join(","));
export {};
