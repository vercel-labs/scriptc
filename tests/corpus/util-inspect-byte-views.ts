// The byte views under inspect and format. A DataView renders its
// [byteLength], [byteOffset] and the backing ArrayBuffer (with its
// [Uint8Contents] at a visible depth and collapsed to [ArrayBuffer] past
// one), exactly as an ArrayBuffer nested in an object does; a numeric
// typed array renders its elements; a Buffer renders its decoded text. %s
// joins a typed array's elements and inspects the DataView (its toString
// is Object.prototype's and DataView is a built-in constructor name), and
// %O / %o inspect the three at their own depths. Node is the oracle.
import { format, formatWithOptions, inspect } from "node:util";

const buffer = new ArrayBuffer(3);
const view = new DataView(buffer, 1);
const bytes = new Uint8Array([7, 8]);
const words = new Float64Array([1.5, 2]);
const bufferBytes = Buffer.from("hi");

console.log(view);
console.log(inspect(view));
console.log(inspect(view, { depth: 0 }));
console.log(inspect(view, { depth: 1 }));
console.log(inspect(view, { depth: null }));
console.log(inspect(view, { showHidden: true }));
console.log(inspect(view, { getters: true }));
console.log(view.byteLength, view.byteOffset, view.buffer.byteLength);

console.log(bytes);
console.log(inspect(bytes, { depth: 0 }));
console.log(words);
console.log(bufferBytes);
console.log({ view, bytes, words, bufferBytes });
console.log([view, bytes]);
console.log(formatWithOptions({ depth: 0 }, "%O", view));
console.log(formatWithOptions({ depth: 0 }, "%O", { view }));

console.log(format("%s", view));
console.log(format("%s", bytes));
console.log(format("%s", words));
console.log(format("%s", bufferBytes));
console.log(format("%f", bytes));
console.log(format("tail", view, bytes));
console.log(format("%s %s", view, bytes));
console.log(format("%O", view), format("%O", bytes), format("%O", bufferBytes));
console.log(format("%o", view), format("%o", bytes));

// A DataView reached as a checked-dynamic value: through an untyped alias
// the %s lane runs the runtime's conversion, the same inspect at depth 0.
const untyped: unknown = view;
const holder = { view: untyped };
console.log(format("%s|%O", untyped, untyped));
console.log(holder);
console.dir(view);
console.dir(view, { depth: null });
