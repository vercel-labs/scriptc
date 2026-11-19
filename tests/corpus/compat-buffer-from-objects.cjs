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

// A second argument is the string form's encoding or the buffer form's byte
// offset. An object shape ignores it, as Node's fromObject does, while a
// string source reads a null encoding as the utf8 default.
console.log("json enc", shape(() => Buffer.from({ type: "Buffer", data: [104, 105] }, "utf8")));
console.log("array-like enc", shape(() => Buffer.from({ length: 2, 0: 65, 1: 66 }, "latin1")));
console.log("number enc", shape(() => Buffer.from(42, "utf8")));
console.log("string null encoding", shape(() => Buffer.from("hé", null).toString("latin1")));

// A primitive wrapper converts through its valueOf, the way a String object
// is a Buffer source to Node.
console.log("string object", shape(() => Buffer.from(new String("hi"))));

// An object's valueOf answer converts as Node's own recursion would: a
// string takes the call's encoding, an ArrayBuffer or SharedArrayBuffer
// becomes a view (the second argument its byte offset and a third its
// length), and any other object converts as if it were the argument.
const storage = new ArrayBuffer(4);
new Uint8Array(storage).set([1, 2, 3, 4]);
const shared = new SharedArrayBuffer(3);
new Uint8Array(shared).set([9, 8, 7]);
const vo = (answer) => ({ valueOf: () => answer });
const runtimeEncoding = "hex";
console.log("valueOf storage", shape(() => Buffer.from(vo(storage))));
console.log("valueOf shared", shape(() => Buffer.from(vo(shared))));
console.log("valueOf storage offset", shape(() => Buffer.from(vo(storage), 2)));
console.log("valueOf storage range", shape(() => Buffer.from(vo(storage), 1, 2)));
console.log("valueOf string encoding", shape(() => Buffer.from(vo("6162"), "hex")));
console.log("valueOf string bad encoding", shape(() => Buffer.from(vo("x"), "bogus")));
console.log("valueOf runtime encoding", shape(() => Buffer.from(vo("6162"), runtimeEncoding)));
console.log("valueOf string utf8", shape(() => Buffer.from(vo("hé"), runtimeEncoding)));
console.log("valueOf array encoding", shape(() => Buffer.from(vo([1, 2]), "hex")));
console.log("valueOf nested", shape(() => Buffer.from(vo(vo("6162")), "hex")));
console.log("valueOf other", shape(() => Buffer.from(vo(5))));

// A valueOf() chain that never reaches a source exhausts the stack, which
// Node reports as its RangeError rather than a fault.
let first, second;
first = { valueOf: () => second };
second = { valueOf: () => first };
console.log("valueOf cycle", shape(() => Buffer.from(first)));

// A single-use hook that drops or replaces its own property while it runs
// keeps the running function and its captured source alive for the rest of
// the call.
function singleUse(source) {
  const holder = { calls: 0 };
  holder.valueOf = () => {
    holder.calls++;
    delete holder.valueOf;
    return source;
  };
  return holder;
}
console.log("valueOf deletes itself", shape(() => Buffer.from(singleUse(Buffer.from([1, 2])))));
console.log("valueOf replaces itself", shape(() => {
  const holder = {
    valueOf: () => {
      holder.valueOf = () => null;
      return "6162";
    },
  };
  return Buffer.from(holder, "hex");
}));
console.log("valueOf mutates source", shape(() => {
  const data = [1, 2, 3];
  const holder = {
    valueOf: () => {
      data.length = 2;
      delete holder.valueOf;
      return data;
    },
  };
  return Buffer.from(holder);
}));
