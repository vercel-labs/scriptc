// `.length` on a union of arrays (and strings): every arm answers its own
// length, so the read dispatches on the tag instead of demanding one
// record arm that carries a `length` field.
interface Model {
  id: string;
}
interface ModelRef {
  ref: string;
}
function ids(models: Model[] | ModelRef[]): number {
  return models.length;
}
console.log("models", ids([{ id: "a" }, { id: "b" }]));
console.log("refs", ids([{ ref: "r" }, { ref: "s" }, { ref: "t" }]));

function scalars(values: string[] | number[]): number {
  return values.length;
}
console.log("strings", scalars(["a", "b", "c"]));
console.log("numbers", scalars([1, 2]));

function textual(part: string | string[]): number {
  return part.length;
}
console.log("text", textual("hello"));
console.log("parts", textual(["a", "b"]));

// The dispatch reads the value ONCE, even when the receiver is a call.
let calls = 0;
function make(fill: string): string[] {
  calls++;
  return [fill, fill];
}
function measured(part: string | string[]): number {
  return part.length;
}
console.log("call", measured(make("q")), "calls", calls);
