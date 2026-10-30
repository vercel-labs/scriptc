// The Buffer function read as a value: one identity across the global, the
// buffer module and its aliases, Node's own enumerable members in Node's
// order, statics that apply Node's argument handling, instanceof, and a
// poolSize property the pool reads.
"use strict";
const buffer = require("buffer");
const nodeBuffer = require("node:buffer");
const util = require("util");

// bn.js keeps the module's Buffer in a variable assigned under try.
var BnBuffer;
try {
  BnBuffer = require("buffer").Buffer;
} catch (e) {}
const pass = (value) => value;
const Stored = pass(require("buffer").Buffer);
const Alias = Buffer;
const table = { Buffer: buffer.Buffer };

console.log(typeof Stored, Stored.name, Stored.length, Alias.name, Alias.length);
console.log(Stored === Buffer, Stored === globalThis.Buffer, Stored === buffer.Buffer, Stored === nodeBuffer.Buffer);
console.log(Stored === Alias, table.Buffer === Stored, Stored.constructor === Function);
console.log(Stored);
console.log(Object.keys(Stored));
console.log(util.inspect({ nested: { Buffer: Stored } }, { depth: 1 }));

// Statics through the value.
const show = (label, run) => {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
};
show("from string", () => Stored.from("héllo"));
show("from hex", () => Stored.from("6869", "hex"));
show("from empty encoding", () => Stored.from("x", ""));
show("from bad encoding", () => Stored.from("x", "nope"));
show("from array", () => Stored.from([1, 2, 300]));
const storage = new Uint8Array([1, 2, 3, 4, 5]).buffer;
show("from range", () => Stored.from(storage, 1, 3));
show("from number", () => Stored.from(5));
show("alloc", () => Stored.alloc(3, "ab"));
show("alloc fill", () => Stored.alloc(2, 7));
show("alloc string size", () => Stored.alloc("3"));
show("allocUnsafe", () => Stored.allocUnsafe(4).fill(9));
show("allocUnsafe negative", () => Stored.allocUnsafe(-1));
show("allocUnsafe string", () => Stored.allocUnsafe("4"));
show("allocUnsafeSlow", () => Stored.allocUnsafeSlow(2).fill(1));
show("isBuffer", () => [Stored.isBuffer(Buffer.alloc(1)), Stored.isBuffer(new Uint8Array(1)), Stored.isBuffer("x")]);
show("isEncoding", () => [Stored.isEncoding("UTF-8"), Stored.isEncoding(""), Stored.isEncoding("nope"), Stored.isEncoding(1)]);
show("compare", () => Stored.compare(Buffer.from("a"), Buffer.from("b")));
show("compare bad", () => Stored.compare("a", Buffer.from("b")));
show("concat", () => Stored.concat([Buffer.from("ab"), Buffer.from("cd")]));
show("concat length", () => Stored.concat([Buffer.from("ab"), Buffer.from("cd")], 3));
show("concat empty", () => Stored.concat([], "x"));
show("concat bad length", () => Stored.concat([Buffer.from("a")], "x"));
show("concat bad list", () => Stored.concat("x"));
show("byteLength", () => [Stored.byteLength("héllo"), Stored.byteLength("aGk=", "base64"), Stored.byteLength(new Uint16Array(3))]);

// Member values keep one identity, with Node's names and lengths.
const members = [
  [Buffer.from, Stored.from],
  [Buffer.alloc, Stored.alloc],
  [Buffer.allocUnsafe, Stored.allocUnsafe],
  [Buffer.isBuffer, Stored.isBuffer],
  [Buffer.compare, Stored.compare],
  [Buffer.concat, Stored.concat],
  [Buffer.byteLength, Stored.byteLength],
  [Buffer.isEncoding, Stored.isEncoding],
];
console.log(members.map(([a, b]) => `${a.name}/${a.length}/${a === b}`).join(" "));
const isBuffer = require("buffer").Buffer.isBuffer;
console.log(isBuffer(Buffer.from("x")), isBuffer(null), typeof Buffer.allocUnsafe);

// A bn.js-style allocator over Buffer or Array.
function allocate(ArrayType, size) {
  if (ArrayType.allocUnsafe) return ArrayType.allocUnsafe(size);
  return new ArrayType(size);
}
function toArrayLike(ArrayType, size) {
  const made = allocate(ArrayType, size);
  made.fill(4);
  return made;
}
function toBuffer(size) {
  return BnBuffer ? toArrayLike(BnBuffer, size) : null;
}
const made = toBuffer(3);
console.log(made, toArrayLike(Array, 2), made instanceof Stored, made instanceof Buffer);
console.log(new Uint8Array(2) instanceof Stored, Buffer.from("x") instanceof Alias, pass("x") instanceof Stored);

// poolSize: one setting through the value and the static spelling.
console.log(Stored.poolSize, Buffer.poolSize);
Buffer.poolSize = 1024;
console.log(Stored.poolSize);
const small = Buffer.allocUnsafe(600);
console.log(small.buffer.byteLength, Buffer.allocUnsafe(400).buffer.byteLength);
Stored.poolSize = 2048;
console.log(Buffer.poolSize, Buffer.allocUnsafe(600).buffer.byteLength);
Stored.poolSize = 65536;
