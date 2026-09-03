// Type-qualified imports are erased from Node's runtime graph. Inline type
// specifiers and import type therefore execute the value import normally.
import { type Shape, value } from "./types.ts";
import type { Shape as ImportedShape } from "./types.ts";

type LocalShape = Shape & ImportedShape;
const sample: LocalShape = { value };
console.log("success", sample.value);
