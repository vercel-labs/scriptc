// Record width copies beyond parameters and typed initializers: each site
// stores a record in a narrower or differently shaped record type, and the
// program then writes through or compares the copy.
interface Labeled {
  label: string;
}
interface Tagged {
  label: string;
  tag: string;
}
interface Noted {
  label: string;
  note?: string;
}
const tagged: Tagged = { label: "first", tag: "t" };

// A target that adds an optional property is a different shape: a copy.
function annotate(target: Noted): void {
  target.label = "noted";
}
annotate(tagged);

// The empty record type keeps no property, and no identity either.
const anything: {} = tagged;
console.log(anything === tagged);

// An assertion to a narrower record type copies as well.
const asserted = tagged as Labeled;
asserted.label = "asserted";

// So does a later assignment to a binding declared with that type.
let later: Labeled = { label: "later" };
later = tagged;
later.label = "assigned";

// Array elements are stored as copies of the element type.
const list: Labeled[] = [tagged];
for (const item of list) item.label = "element";
console.log(tagged.label);

// A union narrowed by an assertion copies the arm it selects.
interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
const blocks: (TextBlock | ThinkingBlock)[] = [{ type: "text", text: "a" }];
const block = blocks[0] as { text: string };
block.text = "b";

// A view whose every field is unknown keeps the arm it selects: there is no
// field to copy into, so the assertion is pure typing and the value keeps
// its identity.
const unknownField = blocks[0] as { text: unknown };
unknownField.text = "c";
console.log((blocks[0] as TextBlock).text);
const unknownView = blocks[0] as { type: unknown; text: unknown };
unknownView.text = "d";
