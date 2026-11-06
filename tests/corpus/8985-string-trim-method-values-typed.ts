// The trim family as values in a typed source: reading String.prototype.trim
// no longer refuses with SC1090, the value is the same interned function a
// JavaScript source sees, its call/apply forms compile, and a direct call
// keeps its intrinsic lowering.

const trim: (this: unknown) => string = String.prototype.trim;
const trimStart: (this: unknown) => string = String.prototype.trimStart;

function report(label: string, fn: () => unknown): void {
  try {
    console.log(label, "value=" + String(fn()));
  } catch (e) {
    console.log(label, (e as Error).name);
  }
}

console.log("types", typeof trim, typeof trimStart);
console.log("stable", trim === String.prototype.trim, trimStart === String.prototype.trimStart);
report("call-string", () => trim.call("  typed  "));
report("call-number", () => trim.call(7));
report("call-undefined", () => trim.call(undefined));
report("start", () => trimStart.call("  typed  "));
console.log("direct", JSON.stringify("  typed  ".trim()));
