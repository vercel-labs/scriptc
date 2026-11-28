// `+=` of a string onto a `string | null` or `string | undefined` target:
// JavaScript's `null + "x"` is `"nullx"` and `undefined + "x"` is
// `"undefinedx"`, and TypeScript types the compound assignment as string,
// assignable back to the nullable target. The same holds for an optional
// field. Differentially vs Node.
function appendNull(value: string | null): string | null {
  value += "!";
  return value;
}
console.log("null", appendNull(null), appendNull("a"));

function appendUndefined(value: string | undefined): string | undefined {
  value += "?";
  return value;
}
console.log("undefined", appendUndefined(undefined), appendUndefined("b"));

interface Recorded {
  label?: string;
}
function annotate(entry: Recorded): void {
  entry.label += "#";
}
const blank: Recorded = {};
annotate(blank);
console.log("optional missing", blank.label);
const present: Recorded = { label: "x" };
annotate(present);
console.log("optional present", present.label);

// A narrowed union: only the string arm reaches the append.
function narrow(value: string | null): string {
  const text = value === null ? "" : value;
  const copy = text;
  let out: string | null = copy;
  out += "|";
  return out === null ? "" : out;
}
console.log("narrowed", narrow(null), narrow("c"));
