// Frozen sparse arrays reject only the operations that write. Node returns
// the receiver for a reverse that swaps holes with holes, a sort of at most
// one element, an empty fill or copy range, and names the first write the
// array actually needs: "Cannot add property" for a hole, "Cannot delete"
// for a value a hole replaces. Every case below pins one answer, and the
// ones that return the receiver print what the array still holds.

function holes(length: number, entries: [number, string][]): string[] {
  const values = new Array<string>(length);
  for (const [index, value] of entries) values[index] = value;
  return Object.freeze(values) as unknown as string[];
}

function attempt(label: string, make: () => string[], op: (values: string[]) => string[]): void {
  const values = make();
  try {
    const result = op(values);
    console.log(label, "receiver:", result === values, "values:", JSON.stringify(values));
  } catch (error) {
    console.log(label, "threw:", (error as Error).message, "values:", JSON.stringify(values));
  }
}

const center = () => holes(3, [[1, "c"]]);
const allHoles = () => holes(3, []);
const odds = () => holes(5, [[1, "a"], [3, "b"]]);
const lowerOnly = () => holes(2, [[0, "a"]]);
const upperOnly = () => holes(2, [[1, "b"]]);
const dense = () => holes(2, [[0, "y"], [1, "x"]]);

attempt("reverse all holes", allHoles, (a) => a.reverse());
attempt("reverse center", center, (a) => a.reverse());
attempt("reverse two present", odds, (a) => a.reverse());
attempt("reverse lower only", lowerOnly, (a) => a.reverse());
attempt("reverse upper only", upperOnly, (a) => a.reverse());
attempt("reverse dense", dense, (a) => a.reverse());

attempt("sort all holes", allHoles, (a) => a.sort());
attempt("sort center", center, (a) => a.sort());
attempt("sort one late", () => holes(3, [[2, "z"]]), (a) => a.sort());
attempt("sort dense", dense, (a) => a.sort());
attempt("sort single hole", () => holes(1, []), (a) => a.sort());
attempt("sort single value", () => holes(1, [[0, "v"]]), (a) => a.sort());
let comparatorCalls = 0;
function compare(left: string, right: string): number {
  comparatorCalls += 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

attempt("sort comparator single", () => holes(1, [[0, "v"]]), (a) => a.sort(compare));
attempt("sort comparator empty", () => holes(0, []), (a) => a.sort(compare));
console.log("comparator calls:", comparatorCalls);

attempt("fill empty range", allHoles, (a) => a.fill("x", 1, 1));
attempt("fill all holes", allHoles, (a) => a.fill("x"));
attempt("fill from a hole", () => holes(3, [[0, "a"]]), (a) => a.fill("x", 1));
attempt("fill dense", dense, (a) => a.fill("x"));

attempt("copyWithin all holes", allHoles, (a) => a.copyWithin(0, 1));
attempt("copyWithin empty range", allHoles, (a) => a.copyWithin(1, 0, 0));
attempt("copyWithin past the end", allHoles, (a) => a.copyWithin(9, 0));
attempt("copyWithin hole onto a value", () => holes(3, [[0, "a"]]), (a) =>
  a.copyWithin(0, 1),
);
attempt("copyWithin value onto a hole", () => holes(3, [[1, "b"]]), (a) =>
  a.copyWithin(0, 1),
);
attempt("copyWithin dense overlap", () => holes(3, [[0, "a"], [1, "b"], [2, "c"]]), (a) =>
  a.copyWithin(1, 0),
);
