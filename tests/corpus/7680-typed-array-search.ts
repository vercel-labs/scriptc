// TypedArray.prototype.indexOf, lastIndexOf and includes on every numeric
// element kind: strict equality (NaN never found) for indexOf/lastIndexOf,
// SameValueZero (NaN found, -0 equals 0) for includes, and fromIndex as
// ToIntegerOrInfinity, counted from the end when negative.
const bytes = new Uint8Array([1, 2, 10, 3, 10, 255]);
console.log("u8", bytes.indexOf(10), bytes.indexOf(10, 3), bytes.indexOf(10, 5), bytes.lastIndexOf(10));
console.log("u8 from", bytes.indexOf(10, -2), bytes.indexOf(10, -100), bytes.indexOf(1, Infinity), bytes.indexOf(10, 2.9));
console.log("u8 last", bytes.lastIndexOf(10, 3), bytes.lastIndexOf(10, -3), bytes.lastIndexOf(1, -100), bytes.lastIndexOf(255, 99));
console.log("u8 values", bytes.indexOf(256 + 10), bytes.indexOf(-246), bytes.indexOf(10.5), bytes.includes(255), bytes.includes(0));
console.log("u8 includes from", bytes.includes(1, 1), bytes.includes(255, -1), bytes.includes(2, -5));

const clamped = new Uint8ClampedArray([0, 300, -5, 127.5]);
console.log("u8c", clamped.indexOf(255), clamped.indexOf(0, 1), clamped.lastIndexOf(0), clamped.indexOf(128));

const signed = new Int8Array([-1, 127, -128, 0]);
console.log("i8", signed.indexOf(-1), signed.indexOf(255), signed.indexOf(-128), signed.lastIndexOf(0));

const shorts = new Int16Array([5, -300, 5, 7]);
const ushorts = new Uint16Array([65535, 1, 65535]);
console.log("16", shorts.indexOf(-300), shorts.lastIndexOf(5), ushorts.indexOf(-1), ushorts.lastIndexOf(65535, 1));

const ints = new Int32Array([-2147483648, 0, 2147483647, 0]);
const uints = new Uint32Array([4294967295, 3]);
console.log("32", ints.indexOf(2147483647), ints.lastIndexOf(0), uints.indexOf(4294967295), uints.includes(-1));

const floats = new Float64Array([1.5, NaN, -0, 0, Infinity]);
console.log("f64", floats.indexOf(NaN), floats.lastIndexOf(NaN), floats.includes(NaN), floats.indexOf(0), floats.indexOf(-0));
console.log("f64 more", floats.lastIndexOf(0), floats.indexOf(Infinity), floats.includes(-Infinity), floats.includes(NaN, 2));

const singles = new Float32Array([1.1, 0.5, NaN]);
console.log("f32", singles.indexOf(1.1), singles.indexOf(Math.fround(1.1)), singles.indexOf(0.5), singles.includes(NaN), singles.indexOf(NaN));

const empty = new Float64Array(0);
console.log("empty", empty.indexOf(0), empty.lastIndexOf(0), empty.includes(0), empty.includes(0, -1));

// Views search their own window of the buffer.
const buffer = new ArrayBuffer(16);
const whole = new Uint8Array(buffer);
whole.set([9, 9, 1, 2, 9, 3, 9, 9]);
const view = new Uint8Array(buffer, 2, 4);
const sub = whole.subarray(3, 6);
console.log("views", view.indexOf(9), view.lastIndexOf(9), view.indexOf(1), sub.indexOf(9), sub.includes(1), sub.lastIndexOf(3));
const words = new Uint16Array(buffer, 2, 3);
console.log("word view", words.indexOf(0x0201), words.length);

// Shared memory searches the same way.
const shared = new Int32Array(new SharedArrayBuffer(16));
shared[1] = 7;
shared[3] = 7;
console.log("shared", shared.indexOf(7), shared.lastIndexOf(7), shared.includes(0), shared.indexOf(7, 2));

// A loop that finds every occurrence, as a line splitter does.
const text = new TextEncoder().encode("one\ntwo\n\nthree\n");
const lines: number[] = [];
for (let at = text.indexOf(10); at !== -1; at = text.indexOf(10, at + 1)) lines.push(at);
console.log("lines", lines.join(","));

// A Buffer passed as a Uint8Array keeps Buffer's search: a number needle
// is taken as a byte, and a NaN byteOffset searches the whole buffer.
function searchView(view: Uint8Array): string {
  return [view.indexOf(97 + 256), view.lastIndexOf(98, NaN), view.includes(353), view.indexOf(98, -1)].join(",");
}
console.log(searchView(Buffer.from("abcab")), searchView(new Uint8Array([97, 98, 99, 97, 98])));

// An explicit undefined fromIndex converts to NaN, which searches from 0:
// lastIndexOf then looks at index 0 only.
const values = new Int16Array([3, 1, 3, 2, 3]);
const absent: number | undefined = process.argv.length > 99 ? 1 : undefined;
console.log("undefined from", values.indexOf(3, undefined), values.lastIndexOf(3, undefined), values.lastIndexOf(1, undefined), values.includes(2, undefined));
console.log("maybe undefined from", values.indexOf(3, absent), values.lastIndexOf(3, absent), values.includes(1, absent));
