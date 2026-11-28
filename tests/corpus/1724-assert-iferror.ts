// assert.ifError: null/undefined pass; EVERYTHING else throws — falsy
// scalars included — with "ifError got unwanted exception: " + the
// error's message (its name when the message is empty) or the value's
// inspection. Union-typed arguments (the callback-error idiom) dispatch
// per arm.
import assert from "node:assert";

function messageOf(f: () => void): string {
  try {
    f();
    return "NO THROW";
  } catch (e) {
    return e instanceof Error ? `${e.name}|${e.message}` : "not an Error";
  }
}

assert.ifError(null);
assert.ifError(undefined);
console.log("ifError pass ok");
console.log("A ", JSON.stringify(messageOf(() => assert.ifError(new RangeError("boom")))));
console.log("B ", JSON.stringify(messageOf(() => assert.ifError(new RangeError()))));
console.log("C ", JSON.stringify(messageOf(() => assert.ifError("oops"))));
console.log("D ", JSON.stringify(messageOf(() => assert.ifError(0))));
console.log("E ", JSON.stringify(messageOf(() => assert.ifError(false))));
console.log("F ", JSON.stringify(messageOf(() => assert.ifError(0 / 0))));
console.log("G ", JSON.stringify(messageOf(() => assert.ifError(-0))));
// Composites throw too, rendered with util.inspect's defaults.
console.log("H ", JSON.stringify(messageOf(() => assert.ifError({ a: 1 }))));
console.log("I ", JSON.stringify(messageOf(() => assert.ifError([1, 2, 3]))));
console.log("J ", JSON.stringify(messageOf(() => assert.ifError(new Map([["a", 1]])))));
console.log("K ", JSON.stringify(messageOf(() => assert.ifError(function namedFn() {}))));
console.log("L ", JSON.stringify(messageOf(() => assert.ifError(Symbol("s")))));
// A plain object's message is used the way an error's is (Node reads
// err.message for any object, and the constructor's name for an empty one).
console.log("M ", JSON.stringify(messageOf(() => assert.ifError({ message: "boom" }))));
console.log("N ", JSON.stringify(messageOf(() => assert.ifError({ message: "" }))));
console.log("O ", JSON.stringify(messageOf(() => assert.ifError({ message: 42 }))));
console.log("P ", JSON.stringify(messageOf(() => assert.ifError({ name: "MyErr", message: "boom" }))));

// The callback-error idiom: Error | null | undefined per arm.
function viaUnion(e: Error | null | undefined): string {
  return messageOf(() => assert.ifError(e));
}
console.log("U1", JSON.stringify(viaUnion(null)));
console.log("U2", JSON.stringify(viaUnion(undefined)));
console.log("U3", JSON.stringify(viaUnion(new TypeError("t"))));
function viaScalarUnion(e: string | null): string {
  return messageOf(() => assert.ifError(e));
}
console.log("U4", JSON.stringify(viaScalarUnion(null)));
console.log("U5", JSON.stringify(viaScalarUnion("bad")));
console.log("done");
