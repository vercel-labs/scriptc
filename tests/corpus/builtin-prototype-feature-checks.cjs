// Feature checks of a literal key against the ArrayBuffer and typed-array
// prototypes answer as Node does, through every hasOwnProperty spelling.
var hasOwnProperty = Object.prototype.hasOwnProperty,
  supportsDetached = hasOwnProperty.call(ArrayBuffer.prototype, "detached");
console.log(supportsDetached, hasOwnProperty.call(ArrayBuffer.prototype, "missing"));
console.log(
  Object.prototype.hasOwnProperty.call(Uint8Array.prototype, "BYTES_PER_ELEMENT"),
  Object.prototype.hasOwnProperty.call(Float64Array.prototype, "map"),
);
console.log(Object.hasOwn(ArrayBuffer.prototype, "resize"), Object.hasOwn(Int32Array.prototype, "constructor"));
console.log(hasOwnProperty.call(globalThis.ArrayBuffer.prototype, "transfer"));

// A local binding named ArrayBuffer is not the builtin.
function probe(ArrayBuffer) {
  return Object.hasOwn(ArrayBuffer.prototype, "detached");
}
console.log(probe({ prototype: {} }), probe({ prototype: { detached: false } }));
