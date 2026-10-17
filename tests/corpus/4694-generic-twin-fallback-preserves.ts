// Generic bodies whose types the ordinary mapping already handles keep that
// mapping when the call site's resolved signature is also available (the
// resolved-signature twins of 4693 are a fallback only). Pins: a constrained
// parameter's CONSTRAINT members never stand in for unrelated local types; a
// body-local alias shadowing a module alias of the same name keeps its own
// layout; array and Map specializations map through their type arguments.
type Box<T> = { v: T };

function constrained<T extends { a: unknown }>(x: T): number {
  const u: unknown = "hello";
  const n: unknown = 2;
  void x;
  return (typeof u === "string" ? u.length : 0) + (typeof n === "number" ? n : 0);
}
console.log(constrained({ a: 1 }));
console.log(constrained({ a: "s" }));

function shadowed<T>(x: T): Box<T> {
  type Box<U> = { other: U };
  const local: Box<T> = { other: x };
  console.log(typeof local.other);
  return { v: x };
}
console.log(shadowed(1).v + 1);
console.log(shadowed("a").v + "b");

function len<T>(v: T[]): number {
  return v.length;
}
function firstOr<T>(v: T[], fallback: T): T {
  return v.length > 0 ? v[0]! : fallback;
}
function size<K, V>(m: Map<K, V>): number {
  return m.size;
}
console.log(len([1, 2]), len(["a"]), len([true, false, true]));
console.log(firstOr([5, 6], 0), firstOr<string>([], "none"));
console.log(size(new Map([["a", 1], ["b", 2]])));
