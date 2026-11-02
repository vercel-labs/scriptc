// A type assertion over a record is pure typing in Node: the binding holds
// the ORIGINAL object, so a write through it reaches that object, and the
// members the view does not name stay visible through it — in the order the
// object was built with. A projection (`Labeled` over `Tagged`) and the arm
// a union assertion selects (`{ text: string }` over `TextBlock | ...`) both
// keep the value's own storage.
interface Labeled {
  label: string;
}
interface Tagged {
  label: string;
  tag: string;
}

const tagged: Tagged = { label: "first", tag: "t" };
const view = tagged as Labeled;
view.label = "second";
console.log("identity", view === tagged, tagged.label, Object.keys(view).join(","));
console.log("json", JSON.stringify(view));

// A compound assignment writes the same slot the original object holds.
view.label += "!";
console.log("compound", tagged.label, view.label);

// An annotation alongside the assertion keeps the value too.
const annotated: Labeled = tagged as Labeled;
annotated.label = "annotated";
console.log("annotated", tagged.label, JSON.stringify(annotated));

// The same inside a function: the binding is a local view of the argument.
function relabel(target: Tagged): string {
  const local = target as Labeled;
  local.label = "relabeled";
  return target.label + "/" + local.label;
}
console.log("local", relabel({ label: "in", tag: "x" }));

// A union of records: the assertion selects the one arm that stores the
// member the view names, so the write lands in the array element.
interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
const blocks: (TextBlock | ThinkingBlock)[] = [
  { type: "text", text: "a" },
  { type: "thinking", thinking: "b" },
];

function appendText(index: number, text: string): void {
  const block = blocks[index] as { text: string };
  block.text += text;
  // The kept binding is the element itself, so its keys are the element's
  // keys: the arm's own fields, in the order the object was built with.
  console.log("union-keys", Object.keys(block).join(","));
}
appendText(0, "b");
console.log("union", JSON.stringify(blocks[0]), (blocks[0] as TextBlock).text);
