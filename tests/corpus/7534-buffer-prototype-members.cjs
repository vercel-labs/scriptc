// Buffer.prototype members read as values, as smart-buffer probes and
// calls them: own methods are functions with Node's names and lengths that
// run on a Buffer receiver, the parent and offset getters read on the
// prototype answer undefined, constructor is Buffer, and absent names are
// undefined.
"use strict";
const buffer_1 = require("buffer");

function check(method) {
  if (typeof buffer_1.Buffer.prototype[method] === "undefined") return `${method}: missing`;
  return `${method}: ${typeof buffer_1.Buffer.prototype[method]}`;
}
console.log(["writeBigInt64BE", "readBigUInt64LE", "readUInt8", "nope", "parent", "offset"].map(check));
console.log(Buffer.prototype.constructor === Buffer, Buffer.prototype["constructor"] === buffer_1.Buffer);
console.log(Buffer.prototype[0], Buffer.prototype[undefined], Buffer.prototype.toJSON === Buffer.prototype.toJSON);

const names = ["readUInt8", "readUint8", "readFloatLE", "writeUInt16LE", "readUIntLE", "toString", "toLocaleString", "slice", "hexSlice"];
console.log(names.map((n) => `${n}=${JSON.stringify(Buffer.prototype[n].name)}/${Buffer.prototype[n].length}`).join(" "));

const buf = Buffer.alloc(8);
function write(func, value, offset) {
  return func.call(buf, value, offset);
}
console.log(write(Buffer.prototype.writeUInt16LE, 513, 0), write(Buffer.prototype.writeInt8, -2, 2), buf);
console.log(Buffer.prototype.readUInt16LE.call(buf, 0), Buffer.prototype.readInt8.call(buf, 2));
console.log(Buffer.prototype.toString.call(buf, "hex", 0, 3), Buffer.prototype.toLocaleString.call(Buffer.from("hi")));
console.log(Buffer.prototype.slice.call(buf, 0, 2), Buffer.prototype.equals.call(buf, Buffer.alloc(8)));
console.log(Buffer.prototype.fill.call(Buffer.alloc(3), 1), Buffer.prototype.indexOf.call(Buffer.from("abc"), "c"));
console.log(Buffer.prototype.write.call(buf, "zz", 4), buf, Buffer.prototype.toJSON.call(Buffer.from([1])));
