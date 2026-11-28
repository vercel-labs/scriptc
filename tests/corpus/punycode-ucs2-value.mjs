// @exit: 1
// @no-node-shims
// node:punycode's ucs2 object as a value: Node builds it once in
// lib/punycode.js (`ucs2 = { decode: ucs2decode, encode: ucs2encode }`), so
// the property read, a named import and a computed read answer one plain
// object whose two members are the native functions (typeof, name, length,
// identity), destructuring and extracted/bound calls still convert, and
// writes and deletes land on it. A static import links the module before
// anything runs, so its DEP0040 report carries the process id; the @exit
// directive keeps stderr out of the comparison.
import * as punycode from "node:punycode";
import { ucs2 as named } from "node:punycode";

const u = punycode.ucs2;
console.log("typeof", typeof u, typeof u.decode, typeof u.encode);
console.log("identity", u === punycode.ucs2, u === named);
console.log("methods", u.decode === u.decode, u.encode === u.encode);
console.log("names", u.decode.name, u.decode.length, u.encode.name, u.encode.length);
console.log("keys", Object.keys(u).join(","));
console.log("proto", Object.getPrototypeOf(u) === Object.prototype, u.constructor === Object);
const descriptor = Object.getOwnPropertyDescriptor(u, "decode");
console.log("desc", descriptor.writable, descriptor.enumerable, descriptor.configurable);
console.log("member", "decode" in u, u.hasOwnProperty("decode"), "missing" in u);
console.log("shape", JSON.stringify(u), Object.prototype.toString.call(u), String(u));
const { decode, encode } = u;
console.log("destructured", typeof decode, typeof encode);
console.log("call", decode("maana-pta").join(","), encode([109, 97, 241, 97, 110, 97]));
console.log(
  "astral",
  decode("a😀\ud800b").join(","),
  JSON.stringify(encode([0x1f600, 0xd800, 0xdc00])),
);
const bound = decode.bind(u);
console.log("bound", bound("maana-pta").join(","));
console.log("extracted", decode.call(null, "bcher-kva").join(","));
console.log("computed", typeof punycode["ucs2"], punycode["ucs2"] === u);
// The module's own decode/encode are different functions from the ucs2 pair.
console.log("distinct", punycode.decode === u.decode, punycode.encode === u.encode);
const show = (label, f) => {
  try {
    console.log(label, JSON.stringify(f()));
  } catch (e) {
    console.log(label, e.name, e.message);
  }
};
show("roundtrip", () => u.encode(u.decode("x😀\udfffy")) === "x😀\udfffy");
show("encode-range", () => u.encode([0x110000]));
show("encode-fraction", () => u.encode([1.5]));
show("decode-empty", () => u.decode(""));
show("encode-empty", () => u.encode([]));
u.custom = 1;
console.log("write", u.custom, Object.keys(u).join(","));
delete u.custom;
console.log("deleted", u.custom, Object.keys(u).join(","));
process.exitCode = 1;
