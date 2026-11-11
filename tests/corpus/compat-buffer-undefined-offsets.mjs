// JavaScript calls that fill Buffer's numeric slots with values TypeScript
// would not pass: the variable-width readers and writers have no offset
// default, so an undefined offset is Node's ERR_INVALID_ARG_TYPE, checked
// after byteLength for a read and after the value's range for a write. A
// string offset is the same kind of type error, and a valid number offset
// goes through the same ladder.
import { Buffer } from "node:buffer";

function shape(fn) {
  try {
    return "ok " + String(fn());
  } catch (e) {
    return e.name + " " + String(e.code) + " " + e.message;
  }
}

const nums = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

// Variable-width reads: an undefined offset throws; the byteLength is
// validated first, so a bad byteLength reports that instead.
console.log(shape(() => nums.readUIntLE(undefined, 3)));
console.log(shape(() => nums.readUIntBE(undefined, 2)));
console.log(shape(() => nums.readIntLE(undefined, 1)));
console.log(shape(() => nums.readIntBE(undefined, 6)));
console.log(shape(() => nums.readUIntLE(undefined, 7)));
console.log(shape(() => nums.readUIntLE(undefined, "3")));
console.log(shape(() => nums.readUIntLE("0", 2)));
console.log(shape(() => nums.readUIntLE(null, 2)));

// Variable-width writes: the value is converted and range-checked first.
console.log(shape(() => nums.writeUIntLE(5, undefined, 2)));
console.log(shape(() => nums.writeIntBE(-1, undefined, 2)));
console.log(shape(() => nums.writeUIntLE(2 ** 40, undefined, 2)));
console.log(shape(() => nums.writeUIntLE("3", 0, 2)));
console.log(shape(() => nums.writeUIntLE(3, "0", 2)));

// Fixed-width and BigInt accessors default an undefined offset to 0.
console.log(nums.readUInt8(undefined), nums.readUInt16LE(undefined), nums.readDoubleBE(undefined));
console.log(nums.readBigUInt64LE(undefined), nums.readBigInt64BE(undefined));
const out = Buffer.alloc(8);
out.writeUInt16BE(0x1234, undefined);
out.writeBigUInt64LE(0x0102030405060708n, undefined);
console.log(out.toString("hex"));
console.log(shape(() => out.writeUInt8(7, "0")), shape(() => out.writeUInt8(7, null)));
