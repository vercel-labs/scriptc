// Destructuring an `any` source read through a string-literal key
// (`const { value } = events["a.b"]`): reads, renames, defaults, rest, a
// nested pattern, the assignment form, a template-literal key, chained
// string keys, and V8's TypeError for undefined and null sources, whose
// message spells the key as a property name with its text decoded.
const events: any = {
  "a.b": { value: 1, label: "first", extra: true, nested: { deep: "d" } },
  "x-y": { value: 2 },
  outer: { "in.ner": { value: 3 } },
  "nul": null,
};

const { value } = events["a.b"];
const { value: renamed, missing = "fallback", ...rest } = events["a.b"];
const {
  nested: { deep },
} = events["a.b"];
console.log(value, renamed, missing, JSON.stringify(rest), deep);

let assigned: unknown;
({ value: assigned } = events[`x-y`]);
const { value: chained } = events["outer"]["in.ner"];
console.log(assigned, chained);

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, e instanceof TypeError, (e as Error).message);
  }
}
attempt("missing", () => {
  const { value } = events["no.such"];
  return value;
});
attempt("null", () => {
  const { value } = events["nul"];
  return value;
});
attempt("quotes", () => {
  const { value } = events["it's \"quoted\""];
  return value;
});
attempt("escapes", () => {
  const { value } = events["tab\there\nnext"];
  return value;
});
attempt("accents", () => {
  const { value } = events["été ✓"];
  return value;
});
attempt("template", () => {
  const { value } = events[`plain`];
  return value;
});
attempt("assignment", () => {
  let target: unknown;
  ({ value: target } = events["gone"]);
  return target;
});
