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

// Other receivers keep their own lowering.
console.log(hasOwnProperty.call({ a: 1 }, "a"), Object.hasOwn({ b: 2 }, "b"));

// Static members of the constructors still read as Node does.
console.log(Uint8Array.BYTES_PER_ELEMENT, typeof Uint8Array.from, typeof ArrayBuffer.isView);
console.log(ArrayBuffer.name, Uint8Array.length);
