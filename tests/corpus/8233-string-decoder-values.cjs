// A StringDecoder passed to untyped code keeps its identity and its
// pending bytes, and answers write, end and encoding as in Node.
const { StringDecoder } = require("string_decoder");

function feed(decoder, chunks) {
  let out = "";
  for (const chunk of chunks) out += decoder.write(chunk);
  return out + decoder.end();
}

const euro = Buffer.from("€ and 😀");
const utf8 = new StringDecoder("utf-8");
const parts = [];
for (let i = 0; i < euro.length; i++) parts.push(euro.subarray(i, i + 1));
console.log(feed(utf8, parts), utf8.encoding);

const hex = new StringDecoder("hex");
console.log(feed(hex, [Buffer.from([1, 2]), Buffer.from([255])]), hex.encoding);

const utf16 = new StringDecoder("ucs2");
const pending = [Buffer.from([0x61]), Buffer.from([0x00, 0x62]), Buffer.from([0x00])];
console.log(JSON.stringify(feed(utf16, pending)), utf16.encoding);

function passThrough(d) {
  return d;
}
const kept = passThrough(utf8);
console.log(kept === utf8, typeof kept, kept.write("text"), kept.end(Buffer.from([0xf0, 0x9f])));
try {
  kept.write(null);
} catch (e) {
  console.log(e.code, e.message);
}
