// StringDecoder with values whose types are known only at run time, as
// Node's write, end and normalizeEncoding take them: strings pass through,
// any ArrayBufferView decodes as its bytes, other inputs throw
// ERR_INVALID_ARG_TYPE, and encodings that are not strings throw
// ERR_UNKNOWN_ENCODING formatted with %s. Buffer.of builds the inputs.
import { StringDecoder } from "node:string_decoder";

function feed(decoder, chunks) {
  let out = "";
  for (const chunk of chunks) out += decoder.write(chunk);
  return out + decoder.end();
}

function attempt(label, fn) {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const euro = Buffer.of(0xe2, 0x82, 0xac);
console.log(euro, euro.length, Buffer.isBuffer(euro), euro.byteOffset);
console.log(Buffer.of(), Buffer.of(1, 256, -1, 2.9, "7"));

// Strings, Buffers, typed arrays and DataViews in one decoder.
console.log(
  JSON.stringify(
    feed(new StringDecoder("utf8"), [
      euro.subarray(0, 1),
      euro.subarray(1),
      "x",
      new Uint16Array([0x41, 0x42]),
      new DataView(Buffer.of(0xc3, 0xa9).buffer),
    ]),
  ),
);
console.log(JSON.stringify(feed(new StringDecoder("hex"), [new Int8Array([1, -1]), "zz", Buffer.of(16)])));
console.log(JSON.stringify(feed(new StringDecoder("utf16le"), [Buffer.of(0x3d), Buffer.of(0xd8, 0x4d), Buffer.of(0xdc)])));

// end(chunk): a string precedes the flushed partial; undefined only flushes.
const decoder = new StringDecoder("utf8");
decoder.write(euro.subarray(0, 2));
attempt("end string", () => decoder.end("tail"));
attempt("end undefined", () => decoder.end(undefined));
decoder.write(euro.subarray(0, 2));
attempt("end view", () => decoder.end(euro.subarray(2)));

for (const bad of [123, null, {}, [1, 2], new ArrayBuffer(2), undefined, true]) {
  attempt(`write ${typeof bad}`, () => decoder.write(bad));
}
attempt("end number", () => decoder.end(42));

const encodings = [1, -0, NaN, true, 10n, Symbol("s"), {}, [], ["h", "e", "x"], { a: 1, b: { c: 2 } }, "", null];
for (const name of [undefined, "test", "Latin1", "UCS-2", "BASE64URL"]) encodings.push(name);
for (const encoding of encodings) {
  attempt(`encoding ${typeof encoding}`, () => new StringDecoder(encoding).encoding);
}
// An object whose length is 3 to 9 matches by its string in lower case.
const named = (length, text) => ({ length, toString: () => text });
attempt("object hex", () => new StringDecoder(named(3, "HEX")).encoding);
attempt("object ucs2", () => new StringDecoder(named(4, "Ucs2")).encoding);
attempt("object base64url", () => new StringDecoder(named(9, "base64URL")).encoding);
