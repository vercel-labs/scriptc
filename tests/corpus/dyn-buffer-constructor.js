// `.constructor` of a Buffer that reached JavaScript as a checked-dynamic
// value, in a program that never reads the Buffer function itself: the fs
// stream hands Node's Buffer to the 'data' listener, so its constructor is a
// function named "Buffer" (one per process), not a string and not the
// Uint8Array constructor.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctor-"));
const file = path.join(dir, "data.bin");
fs.writeFileSync(file, "hello");

const stream = fs.createReadStream(file);
/** @param {any} chunk */
function onData(chunk) {
  console.log("chunk", typeof chunk, typeof chunk.constructor, chunk.constructor.name);
  console.log("toString", chunk.toString("utf8"));
  const first = chunk.constructor;
  const second = chunk.constructor;
  console.log("identity", first === second, first.name === "Buffer");
}
stream.on("data", onData);
stream.on("end", function () {
  console.log("end");
});

// Typed arrays answer their own constructor through the same path.
function describe(label, value) {
  console.log(label, typeof value.constructor, value.constructor.name);
}
const nums = { u8: new Uint8Array(2), f64: new Float64Array(2), ab: new ArrayBuffer(4) };
/** @type {any} */
const dyn = nums;
describe("u8", dyn.u8);
describe("f64", dyn.f64);
describe("ab", dyn.ab);
console.log("u8-bytes", dyn.u8.constructor.BYTES_PER_ELEMENT, dyn.u8.length);
