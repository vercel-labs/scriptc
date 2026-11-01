// util.inspect with numericSeparator: numbers group their digits in threes,
// the integer part from the right and the fractional part from the left,
// at every depth and inside collections, typed arrays and bigints; the
// built-in numeric properties ([length], [byteLength], [byteOffset]) group
// too, while the counts printed from a template do not. The exponent
// forms, NaN, Infinity, -0 and the strings that spell a number stay as
// they render by default. util.formatWithOptions takes the option
// for %s, %d, %i, %f, %o and the joined arguments (formatNumber and
// formatBigInt), while %j keeps its JSON form. The option reads at run
// time too, and custom inspect functions see it in their options.
import * as util from "node:util";

console.log(util.inspect({ a: 1000, b: -98765.4321, c: 0.000001234, d: 1234.5678 }, { numericSeparator: true }));
console.log(util.inspect({ a: 999, b: -1000, c: 0, d: -0, e: 123456789012345 }, { numericSeparator: true }));
console.log(util.inspect({ a: 1e21, b: 1e-7, c: 1.5e-7, d: 0.1, e: 1 / 3 }, { numericSeparator: true }));
console.log(util.inspect({ a: NaN, b: Infinity, c: -Infinity }, { numericSeparator: true }));
console.log(util.inspect({ a: 1000 }, { numericSeparator: false }));
console.log(util.inspect({ a: 1000 }));

console.log(util.inspect([1000, 2000000], { numericSeparator: true }));
console.log(util.inspect([1, 2, 3, 4, 5], { numericSeparator: true, maxArrayLength: 2 }));
console.log(util.inspect({ a: { b: { c: 100000 } } }, { numericSeparator: true, depth: 3 }));

console.log(util.inspect(new Map([[1000, 2000000]]), { numericSeparator: true }));
console.log(util.inspect(new Set([1000, 2000]), { numericSeparator: true }));
console.log(util.inspect(new Uint32Array([1000, 4000000]), { numericSeparator: true }));
console.log(util.inspect(Buffer.from("1234"), { numericSeparator: true }));

// A built-in numeric property groups its digits the way the walk's property
// values do: an array's [length], a typed array's extras, an ArrayBuffer's
// [byteLength] and a DataView's byte fields. The numbers Node prints from a
// template rather than a property value -- the class-name (N), the trailers
// and the typed array's nested [buffer] fast path -- keep their plain digits.
const buffer = new ArrayBuffer(12345);
console.log(util.inspect([1, 2, 3], { numericSeparator: true, showHidden: true }));
const many: number[] = [];
for (let i = 0; i < 12345; i++) many.push(i);
console.log(util.inspect(many, { numericSeparator: true, showHidden: true, maxArrayLength: 2 }));
console.log(util.inspect(new Uint8Array(buffer), { numericSeparator: true, showHidden: true, maxArrayLength: 2 }));
console.log(util.inspect(new Uint8Array(buffer, 12345), { numericSeparator: true, showHidden: true }));
console.log(util.inspect(buffer, { numericSeparator: true }));
const view: any = new DataView(buffer, 3);
console.log(util.inspect(view, { numericSeparator: true }));

console.log(util.inspect(1234567n, { numericSeparator: true }));
console.log(util.inspect(-1234567n, { numericSeparator: true }));
console.log(util.inspect([1234567890123456789n], { numericSeparator: true }));
console.log(util.inspect(1234567n));

const runtime: util.InspectOptions = { numericSeparator: true };
console.log(util.inspect({ a: 1000 }, runtime));
console.log(util.inspect({ a: 1000 }, { ...runtime, depth: 1 }));
console.log(util.inspect(new Map([[1000, 2000]]), runtime));

const option = true;
console.log(util.inspect({ a: 1000 }, { numericSeparator: option }));

class Meter {
  value = 1000;
  [util.inspect.custom](_depth: number, options: util.InspectOptions): string {
    return `meter(${options.numericSeparator})`;
  }
}
console.log(util.inspect(new Meter(), { numericSeparator: true }));
console.log(util.inspect(new Meter(), { numericSeparator: false }));
console.dir(new Meter(), { numericSeparator: true });
console.dir(new Meter(), { numericSeparator: false });

const formatOptions = { numericSeparator: true };
console.log(util.formatWithOptions(formatOptions, "%s %d %i %f", 1000, 1000, -1234567, 1234.5678));
console.log(util.formatWithOptions(formatOptions, "%o", { a: 1000 }));
console.log(util.formatWithOptions(formatOptions, "%O", [1000]));
console.log(util.formatWithOptions(formatOptions, "%j", { a: 1000 }));
console.log(util.formatWithOptions(formatOptions, "plain", 1000, 2000, 1234567n));
console.log(util.format("plain", 1000, 2000));

console.dir({ a: 1000 }, { numericSeparator: true });
