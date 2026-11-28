// A string read from a wider record is lent to a call only while nothing can
// replace it. A write through a narrower view of the same record does replace
// it, so the callee keeps its own reference across that write: the sanitized
// lane reports a heap use-after-free before the view aliases mark the field
// mutable. Differentially vs Node.
interface Wide {
  name: string;
  extra: number;
}
interface Narrow {
  name: string;
}
function use(text: string, view: Narrow): number {
  view.name = "b".repeat(64);
  return text.length;
}
const wide: Wide = { name: "a".repeat(4096), extra: 1 };
const narrow: Narrow = wide;
console.log("len", use(wide.name, narrow), "wide", wide.name.length);
