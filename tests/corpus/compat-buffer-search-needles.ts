// buf.indexOf/lastIndexOf/includes(value[, byteOffset[, encoding]]): every
// needle kind (number, string with each encoding, Buffer), the byteOffset
// clamp and the bidirectional search order, the empty needle's match at the
// clamped end, and the encoding errors Node raises for a string needle.
import { Buffer } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

const h = Buffer.from("abcabcabc");

// String needles in utf8, over omitted, positive, negative and past-the-end
// offsets.
for (const offset of [undefined, 0, 1, 3, 9, 20, -1, -3, -9, -20, 1.5, 0 / 0]) {
  console.log(
    String(offset),
    h.indexOf("bc", offset),
    h.lastIndexOf("bc", offset),
    h.includes("bc", offset),
  );
}

// Number needles wrap to a byte (ToUint32 & 0xff).
for (const needle of [97, 0, 255, 256, 97 + 256, -159, 111.9, -1]) {
  console.log(needle, h.indexOf(needle), h.lastIndexOf(needle), h.includes(needle));
}

// Buffer needles search byte by byte.
const needles = [Buffer.from("bc"), Buffer.from("ca"), Buffer.from(""), Buffer.from("zz"), Buffer.alloc(0)];
for (const needle of needles) {
  console.log(
    JSON.stringify(needle.toString("latin1")),
    h.indexOf(needle),
    h.lastIndexOf(needle),
    h.includes(needle),
    h.indexOf(needle, 2),
  );
}

// A negative offset past the start clamps to 0 in both directions, so a
// needle at 0 is still found there.
console.log(h.lastIndexOf("a", -99), h.lastIndexOf("a", -9), h.lastIndexOf("abc", -99), h.indexOf("a", -99));

// The empty needle matches at the clamped search end, both directions.
console.log(h.indexOf(""), h.indexOf("", 4), h.indexOf("", 99), h.indexOf("", -99));
console.log(h.lastIndexOf(""), h.lastIndexOf("", 4), h.lastIndexOf("", 0), h.lastIndexOf("", -99));

// A string needle under each encoding is encoded before the search; a utf16le
// search compares whole two-byte units.
const u16 = Buffer.from("abab", "utf16le");
console.log(u16.indexOf("ab", 0, "utf16le"), u16.lastIndexOf("ab", 0, "utf16le"));
console.log(u16.indexOf("ba", 2, "utf16le"), u16.includes("ba", 2, "utf16le"));
console.log(h.indexOf("6263", 0, "hex"), h.indexOf("YmM=", 0, "base64"));
console.log(h.indexOf("6263", "hex"), h.lastIndexOf("6263", 0, "hex"));
console.log(Buffer.from("héllo").indexOf("é"), Buffer.from("héllo").indexOf("é", 2));

// An unknown encoding is Node's ERR_UNKNOWN_ENCODING for a string needle, and
// is read as utf8 for a Buffer needle.
console.log(shape(() => h.indexOf("bc", 0, "bogus" as BufferEncoding)));
console.log(shape(() => h.indexOf("bc", 0, "" as BufferEncoding)));
console.log(shape(() => h.includes("bc", 0, "UTF-8" as BufferEncoding)));
console.log(h.indexOf(Buffer.from("bc"), 0, "bogus" as BufferEncoding));
console.log(h.lastIndexOf(Buffer.from("bc"), 0, "bogus" as BufferEncoding));

// includes answers a boolean for every needle kind and throws nothing.
console.log(h.includes(99), h.includes(99, 5), h.includes(Buffer.from("cab")), h.includes("cab", 1));

// A Uint8Array needle is a Buffer needle for the search.
console.log(h.indexOf(new Uint8Array([98, 99])), h.lastIndexOf(new Uint8Array([98, 99]), 2));
