// A record whose `T | undefined` field is the one field that tells two
// arms of a union apart converts into that union: a value picks the arm
// that declares the field, and undefined picks the arm without it.
type Summary =
  | { written: number; errors: string[]; ignored: number }
  | { written: number; ignored: number };

function summarize(written: number, ignored: number, errors: string[]): Summary {
  return { written, errors: errors.length > 0 ? errors : undefined, ignored };
}
function errorCount(summary: Summary): number {
  return "errors" in summary && summary.errors !== undefined ? summary.errors.length : 0;
}
for (const errors of [[], ["e1", "e2"]]) {
  const summary = summarize(3, 1, errors);
  console.log(JSON.stringify(summary), errorCount(summary), summary.written + summary.ignored);
}

type Lookup = { name: string; value: number; source: string } | { name: string; source: string };
const values = new Map<string, number>([["a", 1]]);
const lookups: Lookup[] = ["a", "b"].map((name) => ({
  name,
  value: values.get(name),
  source: "map",
}));
console.log(JSON.stringify(lookups));
