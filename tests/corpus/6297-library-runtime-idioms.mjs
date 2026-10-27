// Runtime idioms from jose's dist build: the Uint8Array base64/hex
// feature probes (absent in Node 24), String.fromCharCode.apply over byte
// chunks and number lists (the btoa fallback), and structuredClone of a
// parameter whose default is `{}` called with differently shaped objects.
console.log(typeof Uint8Array.prototype.toBase64, typeof Uint8Array.prototype.toHex);
console.log(typeof Uint8Array.prototype.setFromBase64, typeof Uint8Array.prototype.setFromHex);

function encodeBase64(input) {
  if (Uint8Array.prototype.toBase64) return input.toBase64();
  const CHUNK_SIZE = 4, arr = [];
  for (let i = 0; i < input.length; i += CHUNK_SIZE)
    arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
  return btoa(arr.join(""));
}
console.log(encodeBase64(new TextEncoder().encode("hello, base64 chunks")));
console.log(encodeBase64(new Uint8Array([0, 255, 128, 1, 2])));

const bytes = new Uint8Array([104, 105]);
console.log(String.fromCharCode.apply(null, bytes), String.fromCharCode.apply(undefined, [72, 73]));
const untyped = JSON.parse("[79, 75]");
console.log(String.fromCharCode.apply(null, untyped), String.fromCharCode.apply(null, []).length);

let store;
class Builder {
  constructor(payload = {}) {
    (store ||= new WeakMap()).set(this, structuredClone(payload));
  }
  claims() {
    return JSON.stringify(store.get(this));
  }
}
console.log(new Builder({ role: "admin", exp: 5 }).claims());
console.log(new Builder({ scope: "read" }).claims());
console.log(new Builder().claims());
