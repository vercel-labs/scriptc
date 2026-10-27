// Two packages that compile from their JavaScript, with types only their
// .d.ts declares: one re-exports types its entry imports
// (`import type { Kind } from "./kinds"; export { Kind }`), the other's
// runtime entry is an ES module (`.mjs`). Declarations using those types
// keep TypeScript's types: the empty arrays the packages fill hold the
// declared rows.
import { addShapes, type Form, type Kind } from "shape-kinds";
import { readRows, type Row } from "row-module";

const forms: Form[] = [];
addShapes("c2 s3", forms);
const kinds: Kind[] = forms.map((form) => form.kind);
const first = forms[0]!;
console.log(kinds.join(","), first.size + forms[1]!.size, first.kind === "circle");

const rows: Row[] = [];
const count = readRows("a=1;b=22", rows);
const last = rows[count - 1]!;
console.log(count, last.key, last.value.length);
