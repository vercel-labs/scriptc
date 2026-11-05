// `in` whose receiver is a call result must still run the call exactly once,
// whether the union's arms both declare the key (the answer is static) or not.
interface A {
  kind: string;
  stream: () => string;
}
interface B {
  kind: string;
  stream: () => string;
  extra: number;
}
const side: string[] = [];
function pair(flag: boolean): A | B {
  side.push(flag ? "A" : "B");
  return flag ? { kind: "a", stream: () => "s" } : { kind: "b", stream: () => "s", extra: 1 };
}
function holder(flag: boolean): { api: A | B } {
  side.push("holder");
  return { api: pair(flag) };
}
function same(): { one: A; two: B } {
  side.push("same");
  return { one: { kind: "a", stream: () => "s" }, two: { kind: "b", stream: () => "s", extra: 2 } };
}
console.log("a", "stream" in (holder(true).api as A));
console.log("b", "stream" in (holder(false).api as A));
console.log("missing", "nope" in (holder(true).api as A));
console.log("plain", "stream" in holder(true).api);
console.log("collapsed", "one" in (same() as { one: A }));
console.log("collapsed-missing", "nope" in (same() as { one: A }));
console.log("side", side.join(","));
const obj = holder(false).api;
console.log("var", "stream" in obj, side.length > 0);

// An inherited Object.prototype key over an index-signature record whose
// prototype is probed at runtime: the receiver is a call result, so it must
// run exactly once even though the answer reads it.
interface Bag {
  [key: string]: number;
}
function bag(): Bag {
  side.push("bag");
  return { a: 1 };
}
console.log("inherited", "toString" in bag(), "constructor" in bag());
console.log("side2", side.join(","));
