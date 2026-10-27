// Overload signatures: a generic overload call monomorphizes the
// implementation under the bindings the overload proves (a parameter the
// overload omits is optional in the implementation), and an immutable
// alias of an overloaded declaration projects onto the implementation.
function twice<T>(x: T): T[];
function twice<T>(x: T, n: number): T[];
function twice<T>(x: T, n?: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < (n ?? 2); i++) out.push(x);
  return out;
}
console.log(twice("q").length);
function pick(x: "a"): string;
function pick(x: "b"): number;
function pick(x: "a" | "b"): string | number {
  return x === "a" ? "alpha" : 42;
}
// An immutable declaration alias now projects onto the implementation;
// calls and non-escaping observations such as typeof compile.
const asValue = pick;
console.log(typeof asValue);
