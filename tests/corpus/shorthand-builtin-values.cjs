// A builtin global in a shorthand property (`{ Uint8Array }`) holds the
// value the long form (`{ Uint8Array: Uint8Array }`) and a plain read hold.

const short = {
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  NaN,
  Infinity,
  String,
  Number,
  Boolean,
  BigInt,
  ArrayBuffer,
  Array,
  Map,
  JSON,
  Math,
  encodeURIComponent,
  decodeURI,
  crypto,
  Buffer,
  fetch,
  console,
  setTimeout,
};
const long = {
  Uint8Array: Uint8Array,
  Int8Array: Int8Array,
  Uint8ClampedArray: Uint8ClampedArray,
  Uint16Array: Uint16Array,
  Int16Array: Int16Array,
  Uint32Array: Uint32Array,
  Int32Array: Int32Array,
  Float32Array: Float32Array,
  Float64Array: Float64Array,
  NaN: NaN,
  Infinity: Infinity,
  String: String,
  Number: Number,
  Boolean: Boolean,
  BigInt: BigInt,
  ArrayBuffer: ArrayBuffer,
  Array: Array,
  Map: Map,
  JSON: JSON,
  Math: Math,
  encodeURIComponent: encodeURIComponent,
  decodeURI: decodeURI,
  crypto: crypto,
  Buffer: Buffer,
  fetch: fetch,
  console: console,
  setTimeout: setTimeout,
};

for (const key of Object.keys(long)) {
  const same = Number.isNaN(long[key]) ? Number.isNaN(short[key]) : short[key] === long[key];
  console.log(key, same, typeof short[key]);
}
console.log(short.Uint8Array === Uint8Array, short.Float64Array === Float64Array);
console.log(Object.keys(short).length, Object.keys(short)[0], Object.keys(short)[9]);

// The typed-array constructors construct and keep their names.
const bytes = new short.Uint8Array([1, 2, 300]);
console.log(bytes, bytes instanceof Uint8Array, short.Uint8Array.name, short.Int32Array.BYTES_PER_ELEMENT);
console.log(new short.Float64Array(2).length, short.Int16Array.from([1, -2]));
console.log(short.NaN !== short.NaN, short.Infinity > 1e308, -short.Infinity);

// Shorthand destructuring from the global object reads the same values.
function fromGlobal() {
  const { Uint8Array, Float32Array, NaN, Infinity, Buffer } = globalThis;
  return [Uint8Array === long.Uint8Array, Float32Array === long.Float32Array, Number.isNaN(NaN), Infinity, Buffer === long.Buffer];
}
console.log(fromGlobal());

// A local binding with a builtin's name is the local.
function shadowed() {
  const Uint8Array = "local";
  const NaN = 5;
  return { Uint8Array, NaN };
}
console.log(shadowed());

// The global object's NaN and Infinity are numbers, read or destructured.
function numbersFromGlobal() {
  const { NaN: notANumber, Infinity: infinite } = globalThis;
  return [typeof notANumber, notANumber !== notANumber, infinite, infinite === Infinity];
}
console.log(typeof globalThis.NaN, globalThis.NaN !== globalThis.NaN, globalThis.Infinity, -globalThis.Infinity);
console.log(numbersFromGlobal());
