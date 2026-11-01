// @deferred-fences: 1
// wasm-bindgen's encoder polyfill must stay unexecuted when encodeInto exists.
var encoder = new TextEncoder;
console.log("encodeInto" in encoder, "encode" in encoder, "missing" in encoder);
if (!("encodeInto" in encoder)) encoder.encodeInto = function (text, bytes) {
  const encoded = encoder.encode(text);
  bytes.set(encoded);
  return { read: text.length, written: encoded.length };
};
const bytes = new Uint8Array(8);
console.log(encoder.encodeInto("hé", bytes));
console.log(Array.from(bytes));
var decoder = new TextDecoder;
console.log("decode" in decoder, "encoding" in decoder, "missing" in decoder);
console.log(decoder.decode(bytes.subarray(0, 3)));
var uninitialized;
try {
  console.log("encodeInto" in uninitialized);
} catch (error) {
  console.log(error.name);
}
