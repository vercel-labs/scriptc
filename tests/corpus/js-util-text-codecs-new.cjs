// `new util.TextEncoder(...)`: the util module's members are the global
// classes of the same names in Node, so the construction takes the global
// lowering.
const util = require("node:util");

const encoder = new util.TextEncoder();
console.log(encoder.encoding, encoder.encode("hi").length);

const decoder = new util.TextDecoder("utf-8");
console.log(decoder.encoding, decoder.decode(Uint8Array.of(104, 105)));

const fromGlobal = new TextEncoder();
console.log(encoder.encoding === fromGlobal.encoding, encoder.encode("x").length);
