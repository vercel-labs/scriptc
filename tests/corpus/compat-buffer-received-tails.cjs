// The "Received ..." tail Buffer's argument errors render for a string:
// Node prints the value's own text, cut to 25 UTF-16 units and an ellipsis
// past the 28th, wrapped in single quotes as it stands, and only when the
// text holds a single quote does it switch to the JSON string form. Control
// characters stay part of the message exactly as the value spells them.
const { Buffer, transcode } = require("node:buffer");

function shape(fn) {
  try {
    return "ok " + String(fn());
  } catch (e) {
    return e.name + " " + String(e.code) + " " + e.message;
  }
}

const samples = [
  "plain",
  "x".repeat(28),
  "x".repeat(29),
  "x".repeat(40),
  "it's a buffer",
  "it's a long string with 40 or so chars",
  'a"b',
  'both \' and " quotes',
  "a\\b",
  "a\tb\nc",
  "a\u0000b",
  "\u0000".repeat(28),
  "\u0000".repeat(29),
  "\u0000".repeat(40),
  "\u{1F600}".repeat(14),
  "\u{1F600}".repeat(20),
  "",
];

// The list check of concat, the two operands of compare, equals' argument,
// transcode's source, and a numeric slot that takes a string.
for (const s of samples) {
  console.log("concat", shape(() => Buffer.concat(s, 1)));
  console.log("compare", shape(() => Buffer.compare(s, Buffer.alloc(1))));
  console.log("equals", shape(() => Buffer.alloc(1).equals(s)));
  console.log("transcode", shape(() => transcode(s, "utf8", "latin1")));
  console.log("offset", shape(() => Buffer.alloc(4).readUInt8(s)));
}
