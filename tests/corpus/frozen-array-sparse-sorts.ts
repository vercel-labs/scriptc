// Frozen sparse arrays: the immutable guard names the first write a sort,
// reverse or copyWithin actually needs, treats holes as absent (a delete of
// a hole and a hole-over-hole copy write nothing), and walks the present
// entries rather than the holes between them, so an array whose length is
// past the dense cutoff stays cheap.
export {};

function holes(length: number, entries: [number, string][]): string[] {
  const values = new Array<string>(length);
  for (const [index, value] of entries) values[index] = value;
  return Object.freeze(values) as unknown as string[];
}

function attempt(
  label: string,
  make: () => string[],
  op: (values: string[]) => string[],
  show = true,
): void {
  const values = make();
  try {
    const result = op(values);
    if (show) console.log(label, "receiver:", result === values, "values:", JSON.stringify(values));
    else console.log(label, "receiver:", result === values);
  } catch (error) {
    if (show) console.log(label, "threw:", (error as Error).message, "values:", JSON.stringify(values));
    else console.log(label, "threw:", (error as Error).message);
  }
}

let calls = 0;
function compare(left: string, right: string): number {
  calls += 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
attempt("comparator empty", () => holes(0, []), (a) => a.sort(compare));
console.log("calls", calls);
attempt("comparator single", () => holes(1, [[0, "v"]]), (a) => a.sort(compare));
console.log("calls", calls);
attempt("comparator one late", () => holes(3, [[2, "z"]]), (a) => a.sort(compare));
console.log("calls", calls);
attempt("comparator all holes", () => holes(3, []), (a) => a.sort(compare));
console.log("calls", calls);
attempt("comparator sparse pair", () => holes(3, [[1, "b"], [2, "a"]]), (a) => a.sort(compare));
console.log("calls", calls);
attempt("comparator dense", () => holes(2, [[0, "b"], [1, "a"]]), (a) => a.sort(compare));
console.log("calls", calls);
attempt("comparator hole first", () => holes(3, [[0, "c"], [2, "a"]]), (a) => a.sort(compare));

// With dense and sparse entries together, a present entry in the sparse
// tail can be the first write a backward copyWithin needs even while the
// dense prefix holds a value, and the other way round.
attempt("mixed copyWithin target sparse", () => holes(5, [[0, "a"], [4, "e"]]), (a) =>
  a.copyWithin(3, 1),
);
attempt("mixed copyWithin dense below range", () => holes(6, [[0, "a"], [1, "b"], [2, "c"], [5, "f"]]), (a) =>
  a.copyWithin(1, 0),
);
attempt("mixed copyWithin source sparse", () => holes(5, [[0, "a"], [1, "b"], [4, "e"]]), (a) =>
  a.copyWithin(0, 1),
);

// The first reversed pair that writes is the one with the lowest lower half,
// even when only the upper half of an earlier pair is present.
attempt("reverse upper pairs", () => holes(6, [[4, "d"], [5, "e"]]), (a) => a.reverse());
attempt("reverse last only", () => holes(6, [[5, "e"]]), (a) => a.reverse());
attempt("reverse upper fourth", () => holes(5, [[4, "e"]]), (a) => a.reverse());
attempt("reverse center upper", () => holes(5, [[3, "d"]]), (a) => a.reverse());

// A sparse array whose holes outnumber its values must not make the guard
// walk the holes: the present entries alone decide the first write.
const far = 1_100_000;
function hugeSparse(length: number, entries: [number, string][]): string[] {
  const values = new Array<string>(length);
  for (const [index, value] of entries) values[index] = value;
  return Object.freeze(values) as unknown as string[];
}
attempt("sparse reverse single", () => hugeSparse(far + 1, [[far, "z"]]), (a) => a.reverse(), false);
attempt("sparse sort single", () => hugeSparse(far + 1, [[far, "z"]]), (a) => a.sort(), false);
attempt("sparse sort holes", () => hugeSparse(far + 1, []), (a) => a.sort(), false);
attempt("sparse copyWithin", () => hugeSparse(far + 1, [[far, "z"]]), (a) => a.copyWithin(0, far), false);
// The sparse tail decides a backward copyWithin even when a dense entry
// sits below both ranges: its entry names the first write.
attempt("sparse mixed copyWithin target", () => hugeSparse(far + 3, [[0, "a"], [far + 2, "z"]]), (a) =>
  a.copyWithin(far, far - 1),
false);
// The largest array index keeps its presence through the set guard.
const writable: string[] = [];
writable[4294967294] = "kept";
Object.freeze(writable);
try {
  writable[4294967294] = "lost";
} catch (error) {
  console.log("huge set:", (error as Error).message);
}
