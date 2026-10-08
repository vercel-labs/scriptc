// Object.keys / values / entries over fixed record shapes: the field list
// is compile-time-known; the ORDER is the shape's declaration order, which
// matches Node whenever objects are constructed in declaration order (the
// literals here are — the divergence for reordered construction is
// SEMANTICS.md 36). Omitted optional fields are skipped at runtime, Node's
// missing-key behavior.
interface Point {
  y: number;
  x: number;
  label: string;
}
const p: Point = { y: 2, x: 1, label: "origin-ish" };

// keys: declaration order (y, x, label) — NOT alphabetical.
const ks = Object.keys(p);
console.log(ks.length, ks.join(","));

// entries: [key, value] tuples in the same order; keys read positionally.
const es = Object.entries(p);
console.log(es.length, es[0]![0], es[1]![0], es[2]![0]);

// Uniform field types: values and entries carry plain typed values.
const dims = { w: 3, h: 4 };
console.log(Object.values(dims).reduce((a, b) => a + b, 0));
console.log(Object.keys(dims).join("-"));
for (const e of Object.entries(dims)) {
  console.log(e[0], e[1] * 10);
}
const names = { first: "ada", last: "lovelace" };
console.log(Object.values(names).join(" "));

// Values over a union of field types: each value wraps into its arm.
const mixed = { n: 5, s: "five" };
const mv = Object.values(mixed);
console.log(mv.length, mv[0] === 5, mv[1] === "five");

// Optional fields: an unset optional is skipped — Node's missing key.
function hasAny(opts: { a?: number; b?: string }): boolean {
  return Object.keys(opts).length > 0;
}
console.log(hasAny({ a: 1 }), hasAny({}), hasAny({ b: "x" }));
const partial: { a?: number; b?: string } = { b: "set" };
console.log(Object.keys(partial).join(","));
console.log(Object.entries(partial).length, Object.values(partial).length);

// Single-field shapes.
const single = { only: 42 };
console.log(Object.keys(single).join(""), Object.values(single)[0], Object.entries(single)[0]![0]);
