// Buffer instance surface, one family per block: construction from strings,
// arrays and other buffers, text decoding, the fixed-width, float and
// variable-width readers and writers, views, comparison and search,
// copy/fill/write, iteration, byte swaps, and the range errors the
// accessors throw.
import { Buffer, atob, btoa } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

// Buffer.from over its source kinds.
const text = Buffer.from("héllo");
const bytes = Buffer.from([1, 2, 3, 255]);
const fromBase64 = Buffer.from("aGk=", "base64");
const fromHex = Buffer.from("6869", "hex");
const copyOf = Buffer.from(text);
copyOf[0] = 0x48;
console.log(text.toString("hex"), bytes.toString("hex"), fromBase64.toString(), fromHex.toString());
console.log(copyOf.length, copyOf.toString(), text.toString(), Buffer.isBuffer(copyOf));

// toString encodings and ranges.
const hello = Buffer.from("hello world");
console.log(hello.toString(), hello.toString("base64"), hello.toString("base64url"));
console.log(hello.toString("utf8", 1, 3), hello.toString("latin1"), hello.toString("hex", 0, 2));

// Fixed-width integer readers.
const ints = Buffer.from([0xfe, 0x02, 0x03, 0x84, 0x05, 0x06, 0x07, 0x08]);
console.log(ints.readUInt8(0), ints.readUInt16LE(0), ints.readUInt16BE(0));
console.log(ints.readUInt32LE(0), ints.readUInt32BE(0));
console.log(ints.readInt8(0), ints.readInt16LE(0), ints.readInt16BE(0));
console.log(ints.readInt32LE(0), ints.readInt32BE(0));

// Float readers.
const floats = Buffer.from([0x40, 0x49, 0x0f, 0xdb, 0x05, 0x06, 0x07, 0x08]);
console.log(floats.readFloatLE(0), floats.readFloatBE(0));
console.log(floats.readDoubleLE(0), floats.readDoubleBE(0));

// Variable-width readers.
const wide = Buffer.from([0xfe, 0x02, 0x03, 0x84, 0x05, 0x06]);
console.log(wide.readUIntBE(0, 3), wide.readUIntLE(0, 3), wide.readIntBE(0, 3), wide.readIntLE(0, 3));
console.log(wide.readUIntBE(0, 6), wide.readUIntLE(0, 6));

// Fixed-width writers return the next offset.
const out = Buffer.alloc(32);
let at = out.writeUInt8(250, 0);
at = out.writeUInt16LE(0x1234, at);
at = out.writeUInt16BE(0x1234, at);
at = out.writeUInt32LE(0xdeadbeef, at);
at = out.writeUInt32BE(0xdeadbeef, at);
at = out.writeInt8(-2, at);
at = out.writeInt16LE(-300, at);
at = out.writeInt16BE(-300, at);
at = out.writeInt32LE(-70000, at);
at = out.writeInt32BE(-70000, at);
console.log(at, out.toString("hex"));

// Float writers.
const fout = Buffer.alloc(24);
at = fout.writeFloatLE(1.5, 0);
at = fout.writeFloatBE(1.5, at);
at = fout.writeDoubleLE(Math.PI, at);
at = fout.writeDoubleBE(Math.PI, at);
console.log(at, fout.toString("hex"));

// Variable-width writers.
const vout = Buffer.alloc(12);
at = vout.writeUIntBE(0x123456, 0, 3);
at = vout.writeUIntLE(0x123456, at, 3);
at = vout.writeIntBE(-2, at, 3);
at = vout.writeIntLE(-2, at, 3);
console.log(at, vout.toString("hex"));

// subarray and slice are views over the same bytes.
const letters = Buffer.from("abcdef");
const middle = letters.subarray(1, 4);
const tail = letters.slice(-2);
middle[0] = 0x58;
console.log(middle.toString(), tail.toString(), letters.toString());
console.log(letters.length, letters[0], middle.length, letters[99]);
console.log(typeof middle.byteOffset, middle.byteLength, middle.buffer instanceof ArrayBuffer);

// Comparison and search.
const left = Buffer.from("abcabc");
const right = Buffer.from("abcabd");
console.log(left.equals(right), left.equals(Buffer.from("abcabc")), left.compare(right), right.compare(left));
console.log(left.includes("ca"), left.includes(Buffer.from("zz")), left.indexOf("bc"), left.lastIndexOf("bc"));
console.log(left.indexOf(0x63), left.indexOf("zz"), left.lastIndexOf(0x61));

// copy, fill and write.
const target = Buffer.alloc(8);
const copied = Buffer.from("xyz").copy(target, 2);
target.fill(0x2e, 5);
const written = target.write("ab", 0);
console.log(copied, written, target.toString("hex"), Buffer.alloc(4).fill("ab").toString());

// Iteration.
const small = Buffer.from([7, 8, 9]);
const seen: string[] = [];
for (const [i, v] of small.entries()) seen.push(i + "=" + v);
for (const k of small.keys()) seen.push("k" + k);
for (const v of small.values()) seen.push("v" + v);
for (const v of small) seen.push("i" + v);
console.log(seen.join(","));

// Byte swaps.
const order = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
console.log(Buffer.from(order).swap16().toString("hex"), Buffer.from(order).swap32().toString("hex"));
console.log(Buffer.from(order).swap64().toString("hex"));

// The buffer module's base64 helpers.
console.log(atob("aGk="), btoa("hi"));

// Error shapes: offsets past the end and sizes a swap cannot take.
console.log(shape(() => ints.readUInt32LE(6)));
console.log(shape(() => ints.readUInt8(8)));
console.log(shape(() => out.writeUInt16BE(1, 31)));
console.log(shape(() => Buffer.from([1, 2, 3]).swap16()));
console.log(shape(() => wide.readUIntBE(0, 7)));
