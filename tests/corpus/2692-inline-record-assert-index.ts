// Inline record assertions must materialize the asserted record shape before
// field/key reads select it. These are read-only because width reshapes copy.
const mixed = { a: 1, b: "two" };
console.log((mixed as Record<string, unknown>)["a"]);

const runtimeKey = "b";
console.log((mixed as Record<string, unknown>)[runtimeKey]);

const counts = { one: 1, two: 2 };
const countKey = "two";
console.log((counts as Record<string, number>)[countKey]);

const heterogeneous = { ready: true, label: "yes" };
const unknownValues = heterogeneous as Record<string, unknown>;
console.log(typeof unknownValues["ready"], typeof unknownValues["label"]);

const viaUnknown = { score: 7 };
console.log((viaUnknown as unknown as Record<string, number>)["score"]);

const wide = { a: 11, dropped: 12 };
console.log((wide as { a: number }).a, (wide as { a: number })["a"]);

let trace = "";
function make(): { value: number; spare: number } {
  trace += "receiver,";
  return { value: 6, spare: 7 };
}
function makeKey(): string {
  trace += "key";
  return "value";
}
console.log((make() as Record<string, number>)[makeKey()], trace);
