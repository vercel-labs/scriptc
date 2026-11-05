// Tuple + ref-element-array fences — what stays OUT of the new surface and
// why: dynamic tuple index WRITES, optional/rest tuple elements (no fixed shape), variable-length
// spreads into tuple literals, join on ref-element arrays (JS would
// recursively toString). Map-element arrays now use reference storage;
// keep them here as accepted adjacent coverage.
const pair: [string, number] = ["a", 1];

// Dynamic index: a READ dispatches over the positions (undefined off the
// end, as Node); a WRITE still needs the literal-index shape.
let i = 0;
console.log(pair[i]);
pair[i] = "b";

// Optional and rest elements have no fixed arity/shape.
const opt: [string, number?] = ["x"];
const rest: [string, ...number[]] = ["y", 1, 2];

// Heterogeneous tuples ITERATE now (positions snapshot into the union),
// and the union-typed loop variable PRINTS (per-arm console rendering).
for (const part of pair) {
  console.log(part);
}

// An array's runtime length cannot determine a fixed tuple's positions.
const copy = [...(["a", 1] as (string | number)[])] as [string, number];

// join on ref-element arrays: JS would recursively toString — dishonest.
const recs: { id: number }[] = [{ id: 1 }];
console.log(recs.join(","));
const tuples: [string, string][] = [["k", "v"]];
console.log(tuples.join(";"));
// Map elements compile through the same REF storage as function elements.
const maps: Map<string, number>[] = [];
