// The node:buffer module object: Node's own keys in Node's order, the
// constants it exports, one identity with the globals and the buffer
// spelling, and each documented function called through the module.
const buffer = require("node:buffer");
const plain = require("buffer");

console.log(Object.keys(buffer).join(","));
console.log(Object.keys(buffer).length);

console.log(
  buffer.constants.MAX_LENGTH,
  buffer.constants.MAX_STRING_LENGTH,
  buffer.kMaxLength,
  buffer.kStringMaxLength,
  buffer.INSPECT_MAX_BYTES,
);
console.log(buffer.constants.MAX_LENGTH === buffer.kMaxLength);

// The constants object itself is one identity across spellings and reads.
const constants = buffer.constants;
console.log(constants === plain.constants, constants === buffer.constants);
console.log(Object.keys(constants).join(","), constants.MAX_LENGTH, constants.MAX_STRING_LENGTH);
console.log(JSON.stringify(constants));
console.log(constants.MAX_STRING_LENGTH === buffer.kStringMaxLength);

// The members Node answers for the whole module surface.
console.log(buffer.Buffer === Buffer, buffer.Blob === Blob, buffer.File === File);
console.log(typeof buffer.SlowBuffer, buffer.SlowBuffer.name, buffer.SlowBuffer.length);

console.log(buffer.isAscii(Buffer.from("abc")), buffer.isUtf8(Buffer.from("abc")));
console.log(buffer.isAscii(Buffer.from([0xff])), buffer.isUtf8(Buffer.from([0xff])));
console.log(buffer.transcode(Buffer.from("héllo"), "utf8", "latin1").toString("hex"));
console.log(buffer.atob("aGk="), buffer.btoa("hi"));
console.log(buffer.resolveObjectURL("blob:nodedata:never-registered"));

// The module's documented functions answer through the stored object.
const made = buffer.Buffer.from("abc");
console.log(buffer.Buffer.isBuffer(made), buffer.Buffer.byteLength("abc"));
console.log(buffer.Blob.length, new buffer.Blob(["x"], { type: "text/plain" }).type);
console.log(new buffer.File(["x"], "x.txt").name);
