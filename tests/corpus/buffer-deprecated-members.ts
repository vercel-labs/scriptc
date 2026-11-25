// Buffer's deprecated members, checked the way Node 24 answers them: the
// old slice/subarray pair share one view rule, `parent` is the underlying
// ArrayBuffer (the pool's slab for a pooled allocation), `SlowBuffer` no
// longer exists, and the lowercase-u accessor spellings still read and
// write the same bytes as their UInt namesakes.
import { Buffer } from "node:buffer";

const privateBuffer = Buffer.from(new ArrayBuffer(4));
privateBuffer[0] = 7;
console.log("parent identity", (privateBuffer as any).parent === privateBuffer.buffer);
console.log("parent bytes", (privateBuffer as any).parent.byteLength, privateBuffer.length);

const pooled = Buffer.from("abc");
console.log("pooled parent", (pooled as any).parent === undefined ? "none" : (pooled as any).parent.byteLength >= pooled.byteLength);

// slice and subarray are both views over the same storage; each call makes
// its own wrapper, so the objects differ but the bytes are shared.
const base = Buffer.from("abcdef");
const view = base.subarray(2, 4);
const copied = base.slice(2, 4);
console.log("views", view.toString(), copied.toString(), view === copied, view.buffer === base.buffer, copied.buffer === base.buffer);
view[0] = 0x5a;
console.log("shared bytes", base.toString(), copied.toString());

// SlowBuffer was removed; the property is absent.
console.log("slow buffer", typeof (Buffer as any).SlowBuffer, (Buffer as any).SlowBuffer === undefined);

// The alias spellings are the same accessors.
const alias = Buffer.from("0123456789abcdef", "hex");
console.log(
  "aliases",
  (alias as any).readUint8(0),
  (alias as any).readUint16LE(0),
  (alias as any).readUint16BE(0),
  (alias as any).readUint32LE(0),
  (alias as any).readUint32BE(0),
  (alias as any).readUintLE(0, 3),
  (alias as any).readUintBE(0, 3),
  (alias as any).readBigUint64LE(0),
);
const written = Buffer.alloc(8);
console.log(
  "alias writes",
  (written as any).writeUint8(1, 0),
  (written as any).writeUint16LE(2, 1),
  (written as any).writeUint32BE(3, 3),
  (written as any).writeUintBE(4, 7, 1),
  written.toString("hex"),
);
console.log("alias big write", (written as any).writeBigUint64LE(1n, 0), written.toString("hex"));
