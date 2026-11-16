// Buffer's optional positions: an explicit undefined is Node's default, not
// a value, and a `number | undefined` variable keeps that meaning at run
// time. Covers toString's start/end, write's offset/length, fill's
// offsets, copy's three positions, compare's window, the search offsets,
// the numeric and BigInt accessor offsets, slice/subarray, the
// Buffer.from/alloc/byteLength encoding and length positions, and
// Buffer.concat's totalLength — plus copy's toInteger ladder (fractions
// floor; NaN, ±Infinity and out-of-safe-range values become 0) and the
// range errors that survive it.
import { Buffer } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    const value = fn();
    return "ok " + (typeof value === "bigint" ? value.toString() : String(value));
  } catch (e) {
    const err = e as Error & { code?: string };
    return "ERR " + err.name + " " + String(err.code) + " " + err.message;
  }
}

const bytes = Buffer.from("abcdefgh");
// `let` bindings: the checker types these reads as the union itself, so the
// call receives a number-or-undefined value rather than a narrowed one.
let absent: number | undefined;
let present: number | undefined;
present = 2;
let noEncoding: BufferEncoding | undefined;

// toString(start, end): an undefined start reads as 0 and an undefined end
// as the length.
console.log("toString", shape(() => bytes.toString("utf8", absent, absent)));
console.log("toString", shape(() => bytes.toString("utf8", absent, present)));
console.log("toString", shape(() => bytes.toString("utf8", present, absent)));
console.log("toString", shape(() => bytes.toString("utf8", undefined, undefined)));
console.log("toString", shape(() => bytes.toString("utf8", 1, undefined)));

// write(offset, length): a missing or undefined offset is Node's
// whole-buffer utf8 form — the string goes in from 0 to the end and the
// length and encoding arguments are evaluated but ignored — while a
// present offset honors them, and an undefined length writes to the end.
for (const offset of [absent, present, undefined] as (number | undefined)[]) {
  console.log("write", shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [target.write("xy", offset), target.toString()];
  }));
  console.log("write", shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [target.write("xy", 1, offset), target.toString()];
  }));
}

// The whole-buffer form: the ignored length and encoding change nothing,
// and their expressions still evaluate.
let evaluated = 0;
const tick = (value: number): number => {
  evaluated += 1;
  return value;
};
for (const offset of [absent, undefined] as (number | undefined)[]) {
  console.log("write absent", shape(() => {
    const target = Buffer.alloc(6, 0x2e);
    return [target.write("XY", offset, 1), target.toString()];
  }));
  console.log("write absent", shape(() => {
    const target = Buffer.alloc(6, 0x2e);
    return [target.write("5859", offset, tick(1), "hex"), target.toString(), evaluated];
  }));
  console.log("write absent", shape(() => {
    const target = Buffer.alloc(6, 0x2e);
    return [target.write("5859", offset, "hex"), target.toString()];
  }));
  console.log("write absent", shape(() => {
    const target = Buffer.alloc(6, 0x2e);
    return [target.write("5859", offset, undefined, "hex"), target.toString()];
  }));
}
console.log("write absent short buffer", shape(() => {
  const target = Buffer.alloc(4, 0x2e);
  return [target.write("abcdef", undefined, 2), target.toString()];
}));
// write(string, encoding) reads its encoding from the offset position: the
// offset is 0 there and the encoding IS honored (unlike the absent form).
console.log("write encoding overload", shape(() => {
  const target = Buffer.alloc(6, 0x2e);
  return [target.write("6162", "hex"), target.toString()];
}), shape(() => {
  const target = Buffer.alloc(6, 0x2e);
  return [target.write("ab", "latin1"), target.toString(), target.write("cd", undefined, "latin1")];
}));

// fill(offset, end) for a byte, a string and a Buffer pattern.
for (const offset of [absent, present] as (number | undefined)[]) {
  console.log("fill", shape(() => Buffer.alloc(5, 0x2e).fill(1, offset).toString("hex")));
  console.log("fill", shape(() => Buffer.alloc(5, 0x2e).fill(1, 1, offset).toString("hex")));
  console.log("fill", shape(() => Buffer.alloc(5, 0x2e).fill("ab", offset).toString()));
  console.log("fill", shape(() => Buffer.alloc(5, 0x2e).fill(Buffer.from("cd"), 1, offset).toString()));
}

// copy(targetStart, sourceStart, sourceEnd): an undefined position keeps
// its default, and each present one converts through copyImpl's ladder.
for (const value of [absent, present] as (number | undefined)[]) {
  console.log("copy", shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [bytes.copy(target, value), target.toString()];
  }));
  console.log("copy", shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [bytes.copy(target, 1, value), target.toString()];
  }));
  console.log("copy", shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [bytes.copy(target, 1, 2, value), target.toString()];
  }));
}
for (const value of [NaN, Infinity, -Infinity, 1.5, 2 ** 53, 2 ** 53 - 1, -1, 9]) {
  console.log("copy ladder", String(value), shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [bytes.copy(target, value), target.toString()];
  }));
  console.log("copy ladder", String(value), shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [bytes.copy(target, 0, value), target.toString()];
  }));
  console.log("copy ladder", String(value), shape(() => {
    const target = Buffer.alloc(8, 0x2e);
    return [bytes.copy(target, 0, 1, value), target.toString()];
  }));
}
// A huge integral index is kept (Number.isInteger), so it lands past both
// buffers instead of defaulting like a non-integer one.
console.log("copy ladder", "1e300", shape(() => {
  const target = Buffer.alloc(8, 0x2e);
  return [bytes.copy(target, 1e300), target.toString()];
}));
console.log("copy ladder", "1e300", shape(() => {
  const target = Buffer.alloc(8, 0x2e);
  return [bytes.copy(target, 0, 1, 1e300), target.toString()];
}));

// compare's window positions default the same way.
for (const value of [absent, present] as (number | undefined)[]) {
  console.log("compare", shape(() => Buffer.from("abd").compare(Buffer.from("abc"), value)));
  console.log("compare", shape(() => Buffer.from("abd").compare(Buffer.from("abc"), 0, value)));
  console.log("compare", shape(() => Buffer.from("abd").compare(Buffer.from("abc"), 0, 3, value)));
  console.log("compare", shape(() => Buffer.from("abd").compare(Buffer.from("abc"), 0, 3, 0, value)));
}

// The search offsets: undefined searches the whole buffer (0 forward, the
// last position backward).
for (const value of [absent, present] as (number | undefined)[]) {
  console.log("search", shape(() => bytes.indexOf("c", value)));
  console.log("search", shape(() => bytes.indexOf("63", value, "hex")));
  console.log("search", shape(() => bytes.lastIndexOf("c", value)));
  console.log("search", shape(() => bytes.lastIndexOf("63", value, "hex")));
  console.log("search", shape(() => bytes.includes("c", value)));
  console.log("search", shape(() => bytes.indexOf(Buffer.from("c"), value)));
}

// The accessor offsets read and write at 0 when undefined.
for (const value of [absent, present] as (number | undefined)[]) {
  console.log("read", shape(() => bytes.readUInt8(value)));
  console.log("read", shape(() => bytes.readUInt16LE(value)));
  console.log("read", shape(() => bytes.readDoubleLE(value)));
  console.log("read", shape(() => bytes.readBigUInt64LE(value)));
  console.log("write", shape(() => {
    const target = Buffer.alloc(8);
    return [target.writeUInt8(7, value), target.writeUInt16LE(9, value), target.writeBigUInt64LE(1n, value), target.toString("hex")];
  }));
}

// Views: an undefined start or end is the whole array.
for (const value of [absent, present] as (number | undefined)[]) {
  console.log("views", shape(() => bytes.subarray(value).toString()));
  console.log("views", shape(() => bytes.subarray(1, value).toString()));
  console.log("views", shape(() => bytes.slice(value).toString()));
  console.log("views", shape(() => bytes.slice(1, value).toString()));
}

// The remaining optional positions.
console.log("static", shape(() => Buffer.alloc(4, "ab", noEncoding).toString()));
console.log("static", shape(() => Buffer.from("aGk=", noEncoding).toString()));
console.log("static", shape(() => Buffer.byteLength("abc", noEncoding)));
console.log("static", shape(() => Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], absent).toString()));
console.log("static", shape(() => Buffer.concat([Buffer.from("ab")], present).toString()));
console.log("static", shape(() => Buffer.concat([Buffer.from("ab")], undefined).toString()));
for (const value of [NaN, Infinity, -1, 1.5, 2 ** 53]) {
  console.log("static ladder", String(value), shape(() => Buffer.concat([Buffer.from("ab")], value).toString("hex")));
}
