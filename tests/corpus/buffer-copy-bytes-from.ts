// Buffer.copyBytesFrom(view[, offset[, length]]): a pooled copy of a typed
// array's underlying bytes over [offset, offset + length) in ELEMENT
// indices — a Uint16Array copies two bytes per element, a Float64Array
// eight — with the length clamped to the view, an offset at or past the
// end and an empty view answering an empty Buffer, the copy detached from
// the source, and Node's validateInteger ladder on each supplied position
// (a fraction, NaN and a negative value are ERR_OUT_OF_RANGE; an absent or
// explicitly undefined one is the default). A subarray view copies only
// its window.
import { Buffer } from "node:buffer";

function shape(fn: () => Buffer): string {
  try {
    const value = fn();
    return "ok " + value.toString("hex") + " len=" + value.length;
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const bytes = new Uint8Array([1, 2, 3]);
console.log("plain", shape(() => Buffer.copyBytesFrom(bytes)));
console.log("offset", shape(() => Buffer.copyBytesFrom(bytes, 1)), shape(() => Buffer.copyBytesFrom(bytes, 2)), shape(() => Buffer.copyBytesFrom(bytes, 3)), shape(() => Buffer.copyBytesFrom(bytes, 9)));
console.log("length", shape(() => Buffer.copyBytesFrom(bytes, 1, 1)), shape(() => Buffer.copyBytesFrom(bytes, 1, 0)), shape(() => Buffer.copyBytesFrom(bytes, 1, 99)), shape(() => Buffer.copyBytesFrom(bytes, 2, 9)));
console.log("undefined positions", shape(() => Buffer.copyBytesFrom(bytes, undefined, undefined)), shape(() => Buffer.copyBytesFrom(bytes, undefined, 2)), shape(() => Buffer.copyBytesFrom(bytes, 1, undefined)));

const words = new Uint16Array([0x0102, 0x0304]);
console.log("wider", shape(() => Buffer.copyBytesFrom(words)), shape(() => Buffer.copyBytesFrom(words, 1)), shape(() => Buffer.copyBytesFrom(words, 1, 1)));
const doubles = new Float64Array([1.5]);
console.log("float", shape(() => Buffer.copyBytesFrom(doubles)));
const int16 = new Int16Array([-1, 258]);
console.log("signed", shape(() => Buffer.copyBytesFrom(int16)));
console.log("subarray view", shape(() => Buffer.copyBytesFrom(bytes.subarray(1))), shape(() => Buffer.copyBytesFrom(words.subarray(1))));

// The copy is detached: mutating the source leaves the Buffer alone.
const source = new Uint8Array([7, 8, 9]);
const copied = Buffer.copyBytesFrom(source);
source[0] = 0;
console.log("detached", copied.toString("hex"), Buffer.isBuffer(copied), copied.byteLength === copied.length);

// An empty view answers an empty Buffer before either position is read.
const empty = new Uint8Array(0);
console.log("empty", shape(() => Buffer.copyBytesFrom(empty)), shape(() => Buffer.copyBytesFrom(empty, -1)), shape(() => Buffer.copyBytesFrom(empty, 0, -1)));

// The position ladder.
for (const position of [-1, -0.5, 1.5, NaN, Infinity, -Infinity]) {
  console.log("offset ladder", String(position), shape(() => Buffer.copyBytesFrom(bytes, position)));
  console.log("length ladder", String(position), shape(() => Buffer.copyBytesFrom(bytes, 0, position)));
}
