// @dynamic
// Type-qualified imports stay out of the island's runtime module graph.
import { type Shape, value } from "./types.ts";
import type { Shape as ImportedShape } from "./types.ts";

type LocalShape = Shape & ImportedShape;
const sample: LocalShape = { value };
console.log("dynamic success", sample.value);
