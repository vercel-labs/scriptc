// util.inspect with showHidden, as the option object and as the legacy
// boolean second argument: an array gains its hidden [length] entry after
// the elements, a typed array its [BYTES_PER_ELEMENT], [length],
// [byteLength], [byteOffset] and [buffer] extras, and objects their hidden
// keys, at every depth and inside collections too; the kinds whose entries
// do not change print what they print by default. %o is the showHidden
// walk, and formatWithOptions carries the option into %O.
import * as util from "node:util";

const numbers = [1, 2, 3];
console.log(util.inspect(numbers, { showHidden: true }));
console.log(util.inspect([], { showHidden: true }));
console.log(util.inspect(numbers));
console.log(util.inspect(numbers, true));
console.log(util.inspect(numbers, false));
console.log(util.inspect({ x: [1] }, true, 1));

const record = { tag: "r", list: [1] };
console.log(util.inspect(record, { showHidden: true }));
console.log(util.inspect({ nested: [1, [2]] }, { showHidden: true, depth: 1 }));
console.log(util.inspect({ nested: [1] }, { showHidden: true, depth: 0 }));

const grouped = Array.from({ length: 8 }, (_, i) => i);
console.log(util.inspect(grouped, { showHidden: true }));
console.log(util.inspect(grouped, { showHidden: true, breakLength: 16, compact: false }));
console.log(util.inspect(grouped, { showHidden: true, maxArrayLength: 3 }));

console.log(util.inspect(new Map([["k", [1, 2]]]), { showHidden: true }));
console.log(util.inspect(new Set([[1, 2]]), { showHidden: true }));
console.log(util.inspect(new Date(0), { showHidden: true }));

const bytes = new Uint8Array([1, 2]);
console.log(util.inspect(bytes, { showHidden: true }));
console.log(util.inspect(new Uint8Array(0), { showHidden: true }));
console.log(util.inspect(new Uint16Array([1, 2, 3]).subarray(1), { showHidden: true }));
const buffer = new ArrayBuffer(4);
console.log(util.inspect(new Uint8Array(buffer, 1, 2), { showHidden: true }));
console.log(util.inspect(buffer, { showHidden: true }));
console.log(util.inspect(new DataView(buffer, 1, 2), { showHidden: true }));
console.log(util.inspect(Buffer.from("hi"), { showHidden: true }));
const tagged = new Uint8Array([1, 2]);
(tagged as unknown as Record<string, unknown>).tag = "t";
console.log(util.inspect(tagged, { showHidden: true }));

console.log(util.format("%o", [1, 2]));
console.log(util.format("%o", { a: [1] }));
console.log(util.format("%O", [1, 2]));
console.log(util.formatWithOptions({ showHidden: true }, "%O", [1]));

// An options object held in a variable is read at run time.
const heldOptions: util.InspectOptions = { showHidden: true };
console.log(util.inspect([1, 2], heldOptions));
