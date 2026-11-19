// Buffer's numeric accessors across every width and endianness: each
// fixed-width, float, double and BigInt reader over every in-range
// offset, the variable-width (1-6 byte) pair, every writer's value
// truncation and IEEE-754 storage, and the validation ladder the
// accessors share — offsets (fractions, NaN, ±Infinity, negatives, the
// last legal offset and one past it), byteLength bounds, value range,
// and windows past the end — with Node's codes and messages, plus the
// omitted-offset and omitted-byteLength forms.
import { Buffer } from "node:buffer";

const shape = (label: string, fn: () => unknown): void => {
  try {
    const value = fn();
    console.log(label, "ok", typeof value === "bigint" ? value.toString() : String(value));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(label, "ERR", err.name, String(err.code), err.message);
  }
};

const bytes = Buffer.from("fec1a2ff00e17f9c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9", "hex");
const len = bytes.length;

// Readers: every in-range offset of the byte string, in order.
for (let i = 0; i + 8 <= len; i++) shape("readUInt8 " + i, () => bytes.readUInt8(i));
for (let i = 0; i + 8 <= len; i++) shape("readInt8 " + i, () => bytes.readInt8(i));
for (let i = 0; i + 8 <= len; i++) shape("readUInt16BE " + i, () => bytes.readUInt16BE(i));
for (let i = 0; i + 8 <= len; i++) shape("readUInt16LE " + i, () => bytes.readUInt16LE(i));
for (let i = 0; i + 8 <= len; i++) shape("readInt16BE " + i, () => bytes.readInt16BE(i));
for (let i = 0; i + 8 <= len; i++) shape("readInt16LE " + i, () => bytes.readInt16LE(i));
for (let i = 0; i + 8 <= len; i++) shape("readUInt32BE " + i, () => bytes.readUInt32BE(i));
for (let i = 0; i + 8 <= len; i++) shape("readUInt32LE " + i, () => bytes.readUInt32LE(i));
for (let i = 0; i + 8 <= len; i++) shape("readInt32BE " + i, () => bytes.readInt32BE(i));
for (let i = 0; i + 8 <= len; i++) shape("readInt32LE " + i, () => bytes.readInt32LE(i));
for (let i = 0; i + 8 <= len; i++) shape("readFloatBE " + i, () => bytes.readFloatBE(i));
for (let i = 0; i + 8 <= len; i++) shape("readFloatLE " + i, () => bytes.readFloatLE(i));
for (let i = 0; i + 8 <= len; i++) shape("readDoubleBE " + i, () => bytes.readDoubleBE(i));
for (let i = 0; i + 8 <= len; i++) shape("readDoubleLE " + i, () => bytes.readDoubleLE(i));
for (let i = 0; i + 8 <= len; i++) shape("readBigInt64BE " + i, () => bytes.readBigInt64BE(i));
for (let i = 0; i + 8 <= len; i++) shape("readBigInt64LE " + i, () => bytes.readBigInt64LE(i));
for (let i = 0; i + 8 <= len; i++) shape("readBigUInt64BE " + i, () => bytes.readBigUInt64BE(i));
for (let i = 0; i + 8 <= len; i++) shape("readBigUInt64LE " + i, () => bytes.readBigUInt64LE(i));

// The variable-width pair, 1 to 6 units from three starting offsets.
for (const width of [1, 2, 3, 4, 5, 6]) for (const at of [0, 1, len - 6]) shape("readUIntLE " + width + " " + at, () => bytes.readUIntLE(at, width));
for (const width of [1, 2, 3, 4, 5, 6]) for (const at of [0, 1, len - 6]) shape("readUIntBE " + width + " " + at, () => bytes.readUIntBE(at, width));
for (const width of [1, 2, 3, 4, 5, 6]) for (const at of [0, 1, len - 6]) shape("readIntLE " + width + " " + at, () => bytes.readIntLE(at, width));
for (const width of [1, 2, 3, 4, 5, 6]) for (const at of [0, 1, len - 6]) shape("readIntBE " + width + " " + at, () => bytes.readIntBE(at, width));

// Writers: truncation for integers, IEEE-754 for the float formats, the
// whole 64-bit range (and its wrap) for BigInt, at offset 1.
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(1 + 2, 0xaa); shape("writeUInt8 " + String(value), () => target.writeUInt8(value as any, 1)); console.log("writeUInt8 bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(1 + 2, 0xaa); shape("writeInt8 " + String(value), () => target.writeInt8(value as any, 1)); console.log("writeInt8 bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(2 + 2, 0xaa); shape("writeUInt16BE " + String(value), () => target.writeUInt16BE(value as any, 1)); console.log("writeUInt16BE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(2 + 2, 0xaa); shape("writeUInt16LE " + String(value), () => target.writeUInt16LE(value as any, 1)); console.log("writeUInt16LE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(2 + 2, 0xaa); shape("writeInt16BE " + String(value), () => target.writeInt16BE(value as any, 1)); console.log("writeInt16BE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(2 + 2, 0xaa); shape("writeInt16LE " + String(value), () => target.writeInt16LE(value as any, 1)); console.log("writeInt16LE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(4 + 2, 0xaa); shape("writeUInt32BE " + String(value), () => target.writeUInt32BE(value as any, 1)); console.log("writeUInt32BE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(4 + 2, 0xaa); shape("writeUInt32LE " + String(value), () => target.writeUInt32LE(value as any, 1)); console.log("writeUInt32LE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(4 + 2, 0xaa); shape("writeInt32BE " + String(value), () => target.writeInt32BE(value as any, 1)); console.log("writeInt32BE bytes", target.toString("hex")); }
for (const value of [0, 1, -1, 127, 128, 255, 256, 65535, 65536, -32768, -32769, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 2 ** 53, 1.5, NaN]) { const target = Buffer.alloc(4 + 2, 0xaa); shape("writeInt32LE " + String(value), () => target.writeInt32LE(value as any, 1)); console.log("writeInt32LE bytes", target.toString("hex")); }
for (const value of [0, -0, 1.5, -2.5, Infinity, -Infinity, NaN, 5e-324, 1.7976931348623157e308]) { const target = Buffer.alloc(4 + 2, 0xaa); shape("writeFloatBE " + String(value), () => target.writeFloatBE(value as any, 1)); console.log("writeFloatBE bytes", target.toString("hex")); }
for (const value of [0, -0, 1.5, -2.5, Infinity, -Infinity, NaN, 5e-324, 1.7976931348623157e308]) { const target = Buffer.alloc(4 + 2, 0xaa); shape("writeFloatLE " + String(value), () => target.writeFloatLE(value as any, 1)); console.log("writeFloatLE bytes", target.toString("hex")); }
for (const value of [0, -0, 1.5, -2.5, Infinity, -Infinity, NaN, 5e-324, 1.7976931348623157e308]) { const target = Buffer.alloc(8 + 2, 0xaa); shape("writeDoubleBE " + String(value), () => target.writeDoubleBE(value as any, 1)); console.log("writeDoubleBE bytes", target.toString("hex")); }
for (const value of [0, -0, 1.5, -2.5, Infinity, -Infinity, NaN, 5e-324, 1.7976931348623157e308]) { const target = Buffer.alloc(8 + 2, 0xaa); shape("writeDoubleLE " + String(value), () => target.writeDoubleLE(value as any, 1)); console.log("writeDoubleLE bytes", target.toString("hex")); }
for (const value of [0n, 1n, -1n, (2n ** 64n) - 1n, ((2n ** 64n) - 1n) * -2n, 2n ** 63n, -(2n ** 63n), -(2n ** 63n) - 1n]) { const target = Buffer.alloc(8 + 2, 0xaa); shape("writeBigInt64BE " + String(value), () => target.writeBigInt64BE(value as any, 1)); console.log("writeBigInt64BE bytes", target.toString("hex")); }
for (const value of [0n, 1n, -1n, (2n ** 64n) - 1n, ((2n ** 64n) - 1n) * -2n, 2n ** 63n, -(2n ** 63n), -(2n ** 63n) - 1n]) { const target = Buffer.alloc(8 + 2, 0xaa); shape("writeBigInt64LE " + String(value), () => target.writeBigInt64LE(value as any, 1)); console.log("writeBigInt64LE bytes", target.toString("hex")); }
for (const value of [0n, 1n, -1n, (2n ** 64n) - 1n, ((2n ** 64n) - 1n) * -2n, 2n ** 63n, -(2n ** 63n), -(2n ** 63n) - 1n]) { const target = Buffer.alloc(8 + 2, 0xaa); shape("writeBigUInt64BE " + String(value), () => target.writeBigUInt64BE(value as any, 1)); console.log("writeBigUInt64BE bytes", target.toString("hex")); }
for (const value of [0n, 1n, -1n, (2n ** 64n) - 1n, ((2n ** 64n) - 1n) * -2n, 2n ** 63n, -(2n ** 63n), -(2n ** 63n) - 1n]) { const target = Buffer.alloc(8 + 2, 0xaa); shape("writeBigUInt64LE " + String(value), () => target.writeBigUInt64LE(value as any, 1)); console.log("writeBigUInt64LE bytes", target.toString("hex")); }

// Variable-width writers: out-of-range values are range errors, in-range
// ones store big endian or little endian.
for (const width of [1, 2, 3, 6]) for (const value of [0, 1, -1, 255, 256, 65535, 16777215, -8388608, 2 ** 40, -(2 ** 40)]) { const target = Buffer.alloc(width + 1, 0xaa); shape("writeUIntLE " + width + " " + value, () => target.writeUIntLE(value, 1, width)); console.log("writeUIntLE bytes", target.toString("hex")); }
for (const width of [1, 2, 3, 6]) for (const value of [0, 1, -1, 255, 256, 65535, 16777215, -8388608, 2 ** 40, -(2 ** 40)]) { const target = Buffer.alloc(width + 1, 0xaa); shape("writeUIntBE " + width + " " + value, () => target.writeUIntBE(value, 1, width)); console.log("writeUIntBE bytes", target.toString("hex")); }
for (const width of [1, 2, 3, 6]) for (const value of [0, 1, -1, 255, 256, 65535, 16777215, -8388608, 2 ** 40, -(2 ** 40)]) { const target = Buffer.alloc(width + 1, 0xaa); shape("writeIntLE " + width + " " + value, () => target.writeIntLE(value, 1, width)); console.log("writeIntLE bytes", target.toString("hex")); }
for (const width of [1, 2, 3, 6]) for (const value of [0, 1, -1, 255, 256, 65535, 16777215, -8388608, 2 ** 40, -(2 ** 40)]) { const target = Buffer.alloc(width + 1, 0xaa); shape("writeIntBE " + width + " " + value, () => target.writeIntBE(value, 1, width)); console.log("writeIntBE bytes", target.toString("hex")); }

// Omitted offsets default to 0 (the write forms included); an omitted
// byteLength is a missing argument, not a default.
const defaults = Buffer.alloc(8);
shape("default writeUInt8", () => defaults.writeUInt8(7));
shape("default writeUInt16LE", () => defaults.writeUInt16LE(0x1234));
shape("default writeUInt32BE", () => defaults.writeUInt32BE(0xdeadbeef));
shape("default writeDoubleLE", () => defaults.writeDoubleLE(1.5));
shape("default writeBigUInt64LE", () => defaults.writeBigUInt64LE(3n));
console.log("default bytes", defaults.toString("hex"));
shape("default readUInt32LE", () => defaults.readUInt32LE());
shape("default readBigUInt64LE", () => defaults.readBigUInt64LE());
shape("default writeUIntBE", () => (defaults as any).writeUIntBE(1, 0));
shape("default readUIntBE", () => (defaults as any).readUIntBE(0));

// The offset ladder, shared by every accessor.
for (const at of [len - 1, len, len + 1, 99, -1, -0, 1.5, NaN, Infinity, -Infinity]) {
  shape("o " + String(at) + " readUInt32LE", () => bytes.readUInt32LE(at));
  shape("o " + String(at) + " readFloatBE", () => bytes.readFloatBE(at));
  shape("o " + String(at) + " readBigUInt64LE", () => bytes.readBigUInt64LE(at));
  const target = Buffer.alloc(8);
  shape("o " + String(at) + " writeUInt32LE", () => target.writeUInt32LE(1, at));
  shape("o " + String(at) + " writeDoubleBE", () => target.writeDoubleBE(1, at));
  shape("o " + String(at) + " writeBigUInt64LE", () => target.writeBigUInt64LE(1n, at));
}

// The byteLength ladder, and windows that run past the end.
for (const width of [0, 1, 6, 7, 8, -1, 1.5, NaN, Infinity, -Infinity]) {
  shape("w " + String(width) + " readUIntLE", () => bytes.readUIntLE(0, width));
  shape("w " + String(width) + " readIntBE", () => bytes.readIntBE(0, width));
  const target = Buffer.alloc(8);
  shape("w " + String(width) + " writeUIntLE", () => target.writeUIntLE(1, 0, width));
  shape("w " + String(width) + " writeIntBE", () => target.writeIntBE(1, 0, width));
}
shape("oob readUIntLE", () => bytes.readUIntLE(len - 2, 3));
shape("oob readIntBE", () => bytes.readIntBE(len - 6, 6));
shape("oob readUIntBE", () => bytes.readUIntBE(len, 1));
shape("oob readBigInt64BE", () => bytes.readBigInt64BE(len - 7));
shape("oob writeIntBE", () => { const t = Buffer.alloc(4); return t.writeIntBE(1, 3, 2); });
shape("range writeUIntBE 24 bits", () => { const t = Buffer.alloc(8); return t.writeUIntBE(2 ** 24, 0, 3); });
shape("range writeIntLE 24 bits", () => { const t = Buffer.alloc(8); return t.writeIntLE(-(2 ** 23) - 0x100, 0, 3); });
shape("range writeUIntLE 48 bits", () => { const t = Buffer.alloc(8); return t.writeUIntLE(2 ** 48, 0, 6); });
shape("range writeIntBE 48 bits", () => { const t = Buffer.alloc(8); return t.writeIntBE(2 ** 47, 0, 6); });
