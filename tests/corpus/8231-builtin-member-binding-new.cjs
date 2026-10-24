// `new` of a builtin class bound through a member of a require() result
// (`const SD = require("string_decoder").StringDecoder`, the spelling of
// Node's own tests): the binding resolves to the class, as the
// destructured `const { StringDecoder } = require(...)` does.
"use strict";
const SD = require("string_decoder").StringDecoder;
const Readable = require("stream").Readable;
const PassThrough = require("stream").PassThrough;
const Transform = require("stream").Transform;

const decoder = new SD("utf8");
console.log(decoder.encoding);
console.log(JSON.stringify(decoder.write(Buffer.from([0xe2, 0x82]))));
console.log(decoder.end(Buffer.from([0xac])));
const hex = new SD("hex");
console.log(hex.encoding, hex.write(Buffer.from("hi")));
console.log(new SD().encoding);

const r = new Readable({ read() {} });
r.on("data", (chunk) => console.log("readable", String(chunk)));
r.on("end", () => console.log("readable end"));
r.push("abc");
r.push(null);

const p = new PassThrough();
p.on("data", (chunk) => console.log("passthrough", String(chunk)));
p.end("xyz");

const upper = new Transform({
  transform(chunk, encoding, callback) {
    callback(null, String(chunk).toUpperCase());
  },
});
upper.on("data", (chunk) => console.log("transform", String(chunk)));
upper.end("shout");
