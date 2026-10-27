// nanoid's fillRandom: crypto.getRandomValues over Buffer windows of an
// untyped helper, plus non-view values that throw TypeMismatchError.
import { getRandomValues } from "node:crypto";
const GET_RANDOM_LIMIT = 65536;
function fillRandom(buffer) {
  let from = 0;
  while (from < buffer.length) {
    const to = Math.min(from + GET_RANDOM_LIMIT, buffer.length);
    crypto.getRandomValues(buffer.subarray(from, to));
    from = to;
  }
}
const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
function nanoid(size = 21) {
  const bytes = Buffer.allocUnsafe(size);
  fillRandom(bytes);
  let id = "";
  for (let i = 0; i < size; i++) id += alphabet[bytes[i] & 63];
  return id;
}
const id = nanoid();
console.log(id.length, /^[A-Za-z0-9_-]+$/.test(id), nanoid(10).length, nanoid(70000).length);
const filled = globalThis.crypto.getRandomValues(new Uint16Array(3));
console.log(filled.length);
for (const value of [new Float64Array(1), new Float32Array(2), new DataView(new ArrayBuffer(2)), new Uint8Array(65537), [1, 2], "x", 5, {}]) {
  try {
    crypto.getRandomValues(value);
    console.log("ok");
  } catch (e) {
    console.log(e.name, e.message);
  }
}
const untyped = JSON.parse("[1]");
try {
  getRandomValues(untyped);
} catch (e) {
  console.log(e.name, e.code, e.message);
}
