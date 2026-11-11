// Buffer's optional argument slots: every documented optional position of
// toString, fill, copy, write, indexOf, lastIndexOf, includes, concat,
// slice, subarray and the numeric readers and writers, both omitted and
// filled with an explicit undefined, plus a `number | undefined` variable
// that picks its arm when the call runs. Node tests every optional slot
// with `=== undefined`, so an explicit undefined behaves like an omitted
// argument; a value that fills the slot is converted exactly as Node does.
import { Buffer } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

const b = Buffer.from("hello world");

// toString(encoding?, start?, end?): an undefined start clamps to 0, an
// undefined end is the receiver's length.
const someStart: number | undefined = 2;
const noStart: number | undefined = undefined;
console.log(JSON.stringify(b.toString(undefined)));
console.log(JSON.stringify(b.toString("utf8", undefined)));
console.log(JSON.stringify(b.toString("utf8", undefined, undefined)));
console.log(JSON.stringify(b.toString("utf8", 2, undefined)));
console.log(JSON.stringify(b.toString(undefined, 1, 3)));
console.log(JSON.stringify(b.toString("hex", undefined, undefined)));
console.log(JSON.stringify(b.toString("base64", undefined)));
console.log(JSON.stringify(b.toString("utf8", someStart)));
console.log(JSON.stringify(b.toString("utf8", noStart, 4)));
console.log(JSON.stringify(b.toString("latin1", 0, noStart)));

// fill(value, offset?, end?, encoding?): an undefined offset fills the whole
// buffer, an undefined end fills to its length.
const filled = (value: number | string, offset?: number | undefined, end?: number | undefined, enc?: BufferEncoding) => {
  const target = Buffer.alloc(5);
  target.fill(value, offset, end, enc);
  return target.toString("hex");
};
console.log(filled(65));
console.log(filled(65, undefined));
console.log(filled(65, 1, undefined));
console.log(filled(65, undefined, undefined));
console.log(filled("ab", undefined));
console.log(filled("ab", 1, undefined, "utf8"));
console.log(filled("6162", undefined, 4, "hex"));
console.log(filled(66, 2, 2));
console.log(filled(66, 3, 1));

// copy(target, targetStart?, sourceStart?, sourceEnd?).
const copied = (targetStart?: number | undefined, sourceStart?: number | undefined, sourceEnd?: number | undefined) => {
  const target = Buffer.alloc(8, 0x2e);
  const count = Buffer.from("abc").copy(target, targetStart, sourceStart, sourceEnd);
  return count + ":" + target.toString("latin1");
};
console.log(copied());
console.log(copied(undefined));
console.log(copied(0, undefined));
console.log(copied(0, 0, undefined));
console.log(copied(undefined, undefined, undefined));
console.log(copied(1, 1, 2));
console.log(copied(7, 2));
console.log(copied(8, 0));

// write(string, offset?, length?, encoding?): Node's first branch — an
// undefined offset — writes utf8 over the whole buffer and ignores the
// encoding argument position entirely.
const written = (offset?: number | undefined, length?: number | undefined, enc?: BufferEncoding) => {
  const target = Buffer.alloc(6);
  const count = target.write("616263", offset, length, enc);
  return count + ":" + target.toString("hex");
};
console.log(written());
console.log(written(undefined));
console.log(written(undefined, undefined, "hex"));
console.log(written(0, undefined));
console.log(written(0, undefined, "hex"));
console.log(written(1, undefined, "hex"));
console.log(written(0, 2));
console.log(written(1, 3));
console.log(written(4, undefined));

// indexOf/lastIndexOf/includes(value, offset?, end?, encoding?): an
// undefined offset searches the whole buffer from its own end.
const h = Buffer.from("abcabcabc");
const anyOffset: number | undefined = 2;
const noOffset: number | undefined = undefined;
console.log(h.indexOf("bc", undefined), h.indexOf("bc", anyOffset), h.indexOf("bc", noOffset));
console.log(h.indexOf("bc", undefined, "utf8"), h.indexOf(98, undefined), h.indexOf(Buffer.from("ca"), undefined));
console.log(h.lastIndexOf("bc", undefined), h.lastIndexOf(97, undefined), h.lastIndexOf("", undefined));
console.log(h.includes("bc", undefined), h.includes(98, undefined), h.includes("ca", anyOffset));
console.log(h.indexOf("", undefined), h.indexOf("", undefined, undefined));

// concat(list, totalLength?): an undefined total is the sum of the parts.
const parts = [Buffer.from("ab"), Buffer.from("cde")];
const anyTotal: number | undefined = 2;
const noTotal: number | undefined = undefined;
console.log(Buffer.concat(parts, undefined).toString());
console.log(Buffer.concat(parts, noTotal).toString());
console.log(Buffer.concat(parts, anyTotal).toString());
console.log(Buffer.concat(parts, 2).toString("hex"));
console.log(Buffer.concat([], undefined).length);

// slice(start?, end?) and subarray(start?, end?) share the typed-array
// clamping; an undefined bound is the receiver's own bound.
console.log(b.slice(undefined).toString());
console.log(b.slice(1, undefined).toString());
console.log(b.slice(undefined, 3).toString());
console.log(b.slice(noStart, someStart).toString());
console.log(b.subarray(undefined).toString());
console.log(b.subarray(2, undefined).toString());
console.log(b.subarray(noStart).toString());

// The numeric readers and writers: an undefined offset reads or writes at 0.
const nums = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const anyAt: number | undefined = 2;
const noAt: number | undefined = undefined;
console.log(nums.readUInt8(undefined), nums.readUInt8(noAt), nums.readUInt16BE(anyAt));
console.log(nums.readInt8(undefined), nums.readInt16LE(undefined), nums.readUInt32LE(undefined));
console.log(nums.readFloatBE(undefined), nums.readDoubleLE(undefined));
// The variable-width family has no offset default; the JavaScript shape of
// an undefined offset there is covered by compat-buffer-undefined-offsets.mjs.
console.log(nums.readUIntLE(0, 3), nums.readIntBE(0, 2), nums.readUIntBE(0, 4));
console.log(nums.readBigUInt64BE(undefined), nums.readBigInt64LE(undefined));
const writtenNums = Buffer.alloc(8);
console.log(writtenNums.writeUInt8(7, undefined), writtenNums.writeUInt16BE(258, noAt), writtenNums.writeInt32LE(-2, anyAt));
console.log(writtenNums.writeFloatBE(1.5, undefined), writtenNums.writeBigUInt64BE(9n, undefined));
console.log(writtenNums.writeUIntBE(5, 2, 2), writtenNums.writeIntLE(-3, anyAt, 3), writtenNums.toString("hex"));

// from(arrayBuffer, byteOffset?, length?): undefined bounds are the whole
// buffer.
const ab = new ArrayBuffer(8);
console.log(Buffer.from(ab, undefined, undefined).length);
console.log(Buffer.from(ab, 2, undefined).length);
console.log(Buffer.from(ab, undefined, 3).length);
const anyOff: number | undefined = 1;
console.log(Buffer.from(ab, anyOff, undefined).length);

// alloc(size, fill?, encoding?): an undefined fill is zeroes.
console.log(Buffer.alloc(3, undefined, undefined).toString("hex"));
console.log(Buffer.alloc(3, undefined, "utf8").toString("hex"));
console.log(Buffer.alloc(3, "a", undefined).toString());

// byteLength(string, encoding?): an undefined encoding is utf8.
const anyEnc: BufferEncoding | undefined = "latin1";
const noEnc: BufferEncoding | undefined = undefined;
console.log(Buffer.byteLength("hé", undefined), Buffer.byteLength("hé", noEnc), Buffer.byteLength("hé", anyEnc));
