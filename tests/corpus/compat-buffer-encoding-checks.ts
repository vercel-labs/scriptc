// buffer.isAscii, buffer.isUtf8 and buffer.transcode: the bytes each
// predicate accepts, the argument kinds they take and the errors they
// raise, and transcode's encoding normalization, conversion results and
// data errors.
import { Buffer, isAscii, isUtf8, transcode } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    const value = fn();
    return "ok " + (Buffer.isBuffer(value) ? "buffer " + value.toString("hex") : String(value));
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

// isAscii accepts bytes below 0x80 only.
for (const values of [[], [0x00, 0x7f], [0x41, 0x80], [0x41, 0xff], [0xe9]]) {
  const input = Buffer.from(values);
  console.log("ascii", input.toString("hex") || "(empty)", isAscii(input));
}
console.log("ascii text", isAscii(Buffer.from("plain")), isAscii(Buffer.from("héllo")), isAscii(Buffer.from("é", "latin1")));

// isUtf8 accepts well-formed UTF-8 only.
for (const values of [
  [],
  [0x41],
  [0xc3, 0xa9],
  [0x80],
  [0xc0, 0xaf],
  [0xe2, 0x82],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xf0, 0x9f, 0x92, 0xa9],
  [0x61, 0x00, 0x62],
  [0xfe, 0xff],
]) {
  const input = Buffer.from(values);
  console.log("utf8", input.toString("hex") || "(empty)", isUtf8(input));
}

// Both take any ArrayBufferView or ArrayBuffer, not a string or DataView.
const backing = new Uint8Array([0xff, 0xc3, 0xa9, 0xff]);
const view = backing.subarray(1, 3);
console.log("view", isAscii(view), isUtf8(view));
console.log("typed", isAscii(new Uint16Array([0x41])), isUtf8(new Int8Array([0x41])));
console.log("buffer", isAscii(backing.buffer), isUtf8(backing.buffer.slice(1, 3)));
console.log("dataview", shape(() => isAscii(new DataView(backing.buffer))), shape(() => isUtf8(new DataView(backing.buffer))));
const asInput = (value: unknown) => value as ArrayBuffer;
console.log("string", shape(() => isAscii(asInput("abc"))), shape(() => isUtf8(asInput("abc"))));
console.log("object", shape(() => isAscii(asInput({}))), shape(() => isUtf8(asInput({}))));
console.log("null", shape(() => isAscii(asInput(null))), shape(() => isUtf8(asInput(null))));

// transcode converts among the four buffer encodings.
const pairs: [string, string, string][] = [
  ["utf8", "utf16le", "héllo"],
  ["utf8", "latin1", "héllo"],
  ["utf8", "ascii", "héllo"],
  ["latin1", "utf8", "héllo"],
  ["utf16le", "utf8", "héllo"],
  ["utf16le", "latin1", "é"],
  ["ascii", "utf8", "hi"],
  ["latin1", "utf16le", "é"],
];
for (const [from, to, text] of pairs) {
  const source = Buffer.from(text, from as BufferEncoding);
  console.log("transcode", from, to, source.toString("hex"), shape(() => transcode(source, from, to)));
}

// Same-encoding conversion still copies.
const original = Buffer.from("copy");
const copy = transcode(original, "utf8", "utf8");
console.log("copy", copy.toString(), copy === original, copy.buffer === original.buffer);

// Encoding names are normalized before the conversion.
console.log("alias", shape(() => transcode(Buffer.from("hi"), "UTF-8", "UCS-2")));
console.log("invented", shape(() => transcode(Buffer.from("hi"), "utf8", "base64")));
console.log("binary", shape(() => transcode(Buffer.from("hi"), "binary", "utf8")));
console.log("number", shape(() => transcode(Buffer.from("hi"), 4 as unknown as string, "utf8")));

// Invalid input data reports the conversion error.
console.log("odd", shape(() => transcode(Buffer.from([0x61]), "utf16le", "utf8")));
console.log("surrogate", shape(() => transcode(Buffer.from([0x00, 0xd8]), "utf16le", "latin1")));
console.log("bad utf8", shape(() => transcode(Buffer.from([0xff]), "utf8", "latin1")));
console.log("truncated", shape(() => transcode(Buffer.from([0xe2, 0x82]), "utf8", "utf16le")));
console.log("empty", shape(() => transcode(Buffer.alloc(0), "utf8", "base64")));
console.log("empty odd", shape(() => transcode(Buffer.alloc(0), "utf16le", "utf8")));

// Source kinds and argument checks.
console.log("typed source", shape(() => transcode(new Uint8Array([0x68, 0x69]), "utf8", "latin1")));
console.log("string source", shape(() => transcode("hi" as unknown as Buffer, "utf8", "latin1")));
