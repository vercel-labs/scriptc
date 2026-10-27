// The buffer module's Buffer through CommonJS bindings — `var Buffer =
// require('buffer').Buffer` and a member of a stored require — is the
// global Buffer constructor, with its statics.
var Buffer = require("buffer").Buffer;
var buffer = require("buffer");
var B2 = buffer.Buffer;
const B3 = require("node:buffer").Buffer;
console.log(Buffer.from("hi").toString("hex"), Buffer.isBuffer(Buffer.alloc(1)), B2.byteLength("héllo"), B2.isBuffer("x"));
console.log(B3.concat([B2.from("a"), Buffer.from([98])]).toString(), B3.alloc(2, 1).toString("base64"));
function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
console.log(toBuffer("abc").length, toBuffer(Buffer.from("xyz")).toString());

// Buffer.from over a JS-inferred `string | Uint8Array | undefined` result
// dispatches on the runtime kind, Node's TypeError for undefined included.
function make(flag) {
  return flag ? "ab" : flag === false ? new Uint8Array([99, 100]) : undefined;
}
console.log(Buffer.from(make(true)).toString(), Buffer.from(make(false)).toString("hex"));
try {
  Buffer.from(make(null));
} catch (e) {
  console.log(e.name, e.code);
}
