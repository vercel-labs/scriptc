// Buffer.from over object sources: the array-like branch the `length`
// property selects, element coercion to bytes, the Buffer JSON shape, and
// the first-argument errors for the values that are not a source.
const { Buffer } = require("node:buffer");

function shape(fn) {
  try {
    const value = fn();
    return "ok " + (Buffer.isBuffer(value) ? Buffer.from(value).toString("hex") || "(empty)" : String(value));
  } catch (e) {
    return e.name + " " + String(e.code) + " " + e.message;
  }
}

// The shape JSON.parse gives a serialized Buffer.
const rehydrated = JSON.parse('{"type":"Buffer","data":[1,2,3]}');
console.log("json", shape(() => Buffer.from(rehydrated)));
console.log("json chars", shape(() => Buffer.from({ type: "Buffer", data: [104, 105] })));
console.log("json empty", shape(() => Buffer.from({ type: "Buffer", data: [] })));
console.log("json bad", shape(() => Buffer.from({ type: "Buffer", data: "no" })));
console.log("json other", shape(() => Buffer.from({ type: "Buffer", data: [1] })));

// An array-like object: `length` decides the size, each element one byte.
console.log("array-like", shape(() => Buffer.from({ length: 2, 0: 65, 1: 66 })));
console.log("missing byte", shape(() => Buffer.from({ length: 3, 0: 65 })));
console.log("string values", shape(() => Buffer.from({ length: 2, 0: "65", 1: "66" })));
console.log("truncated", shape(() => Buffer.from({ length: 4, 0: 256, 1: -1, 2: 1.9, 3: NaN })));
console.log("fractional length", shape(() => Buffer.from({ length: 1.9, 0: 300 })));
console.log("longer length", shape(() => Buffer.from({ length: 4, 0: 1, 1: 2 })));

// A non-number `length` makes an empty Buffer, as do zero and negatives.
console.log("string length", shape(() => Buffer.from({ length: "2", 0: 65 })));
console.log("negative length", shape(() => Buffer.from({ length: -1, 0: 65 })));
console.log("zero length", shape(() => Buffer.from({ length: 0, 0: 65 })));
console.log("null length", shape(() => Buffer.from({ length: null, 0: 65 })));

// A record with numeric keys is array-like through its `length`; the
// elements it does not have read as zero.
console.log("bare buffer", shape(() => Buffer.from({ buffer: new ArrayBuffer(3), byteOffset: 0, length: 3 })));
console.log("empty object", shape(() => Buffer.from({})));

// Elements are coerced with ToNumber, so a Symbol element throws.
console.log("symbol element", shape(() => Buffer.from({ length: 1, 0: Symbol("s") })));

// The values that are not sources at all.
console.log("number", shape(() => Buffer.from(42)));
console.log("true", shape(() => Buffer.from(true)));
console.log("null", shape(() => Buffer.from(null)));
console.log("undefined", shape(() => Buffer.from(undefined)));
console.log("symbol", shape(() => Buffer.from(Symbol("s"))));
console.log("bigint", shape(() => Buffer.from(10n)));
console.log("missing", shape(() => Buffer.from()));
