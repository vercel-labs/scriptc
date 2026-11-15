// A module imported only for its types contributes no code, and the DOM names
// it uses type-check because the project's tsconfig lists "dom" in "lib".
// kinds.ts re-exports a type of ruler.ts, whose functions are for a page.
import type { Labelled, Span } from "./kinds.ts";

function length(span: Span): number {
  return span.to - span.from;
}

const spans: Span[] = [
  { from: 2, to: 9 },
  { from: 11, to: 12 },
];
console.log(
  spans.map(length).join(","),
  spans.reduce((sum, span) => sum + length(span), 0),
);

const labelled: Labelled = { label: "margin", span: spans[0]!, node: null };
console.log(labelled.label, length(labelled.span), labelled.node === null);
