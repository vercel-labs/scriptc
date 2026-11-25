// Buffer's search byteOffset ladder for every needle kind: an empty needle
// (which matches at the clamp), a byte count, a string in its encoding and
// a Buffer, searched forward (indexOf, includes) and backward
// (lastIndexOf). A negative offset counts from the end and one that starts
// before the first byte finds nothing going back — except the empty needle,
// which matches at 0 there; NaN (an omitted offset) searches everything;
// fractions truncate; ±Infinity clamps. utf16le searches whole 2-byte
// units, so an odd offset or haystack handles whole units only.
import { Buffer } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const hay = Buffer.from("abcabcabc");
const empty = Buffer.alloc(0);
const bc = Buffer.from("bc");
const offsets = [-99, -10, -9, -1, 0, 1, 1.5, NaN, 9, 99, 1.5, Infinity, -Infinity, -0];

for (const offset of offsets) {
  console.log(
    String(offset),
    "empty", shape(() => hay.indexOf(empty, offset)), shape(() => hay.lastIndexOf(empty, offset)), shape(() => hay.includes(empty, offset)),
    "byte", shape(() => hay.indexOf(98, offset)), shape(() => hay.lastIndexOf(98, offset)), shape(() => hay.includes(98, offset)),
    "string", shape(() => hay.indexOf("bc", offset)), shape(() => hay.lastIndexOf("bc", offset)), shape(() => hay.includes("bc", offset)),
    "buffer", shape(() => hay.indexOf(bc, offset)), shape(() => hay.lastIndexOf(bc, offset)), shape(() => hay.includes(bc, offset)),
  );
}

// Encoded needles read the encoding for strings, and a runtime name both
// string and Buffer needles get.
for (const offset of [-99, -1, 0, 1, NaN, 99]) {
  console.log(
    String(offset),
    "hex", shape(() => hay.indexOf("6263", offset, "hex")), shape(() => hay.lastIndexOf("6263", offset, "hex")),
    "base64", shape(() => hay.indexOf("YmM=", offset, "base64")), shape(() => hay.lastIndexOf("YmM=", offset, "base64")),
    "latin1", shape(() => hay.indexOf("bc", offset, "latin1")), shape(() => hay.lastIndexOf("bc", offset, "latin1")),
  );
}

// utf16le: whole 2-byte units of both sides; an odd trailing byte is ignored.
const u16 = Buffer.from("610062006300", "hex");
for (const offset of [-99, -1, 0, 1, 2, NaN, 5, 99]) {
  console.log(
    "utf16le",
    String(offset),
    shape(() => u16.indexOf("b", offset, "utf16le")),
    shape(() => u16.lastIndexOf("b", offset, "utf16le")),
    shape(() => u16.includes("b", offset, "utf16le")),
    shape(() => u16.indexOf(Buffer.from("6200", "hex"), offset)),
    shape(() => u16.indexOf("b", offset)),
  );
}
const odd = Buffer.from("6100620063", "hex");
console.log("odd haystack", shape(() => odd.indexOf("b", 0, "utf16le")), shape(() => odd.lastIndexOf("b", 99, "utf16le")), shape(() => odd.includes("c", 4, "utf16le")));

// Encodings that decode to an empty needle (an invalid hex spelling, an
// empty string) search as the empty needle.
console.log("empty decoded", shape(() => hay.indexOf("zz", 0, "hex")), shape(() => hay.lastIndexOf("zz", -99, "hex")), shape(() => hay.indexOf("", 4)), shape(() => hay.lastIndexOf("", -99)));

// Empty haystacks answer -1 (or the clamp for an empty needle).
const none = Buffer.alloc(0);
console.log("empty haystack", shape(() => none.indexOf("a")), shape(() => none.lastIndexOf("a")), shape(() => none.indexOf(empty)), shape(() => none.lastIndexOf(empty)), shape(() => none.includes("a")));

// The static Buffer forms agree.
console.log("static", shape(() => Buffer.compare(hay, bc)), shape(() => Buffer.from("bc").equals(bc)), shape(() => Buffer.byteLength("bc")));
