// A JavaScript guard called from TypeScript with statically typed arrays:
// in the Uint8Array specialization the fallback's receiver narrows to
// never, and its BYTES_PER_ELEMENT read still answers the element size.
import { elementSize, isBytes } from "byte-guards";

const bytes: Uint8Array = new Uint8Array(2);
const words = new Uint16Array(1);
const doubles = new Float64Array(1);
const buffer: unknown = Buffer.alloc(1);
console.log(isBytes(bytes), isBytes(words), isBytes(doubles), isBytes(buffer));
console.log(elementSize(bytes), elementSize(words), elementSize(doubles), elementSize(buffer));
