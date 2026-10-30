// A builtin global in a shorthand property (`{ Uint8Array }`) holds the
// value the long form (`{ Uint8Array: Uint8Array }`) holds.

const short: Record<string, unknown> = {
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
  ArrayBuffer,
  encodeURIComponent,
};
const long: Record<string, unknown> = {
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
  ArrayBuffer: ArrayBuffer,
  encodeURIComponent: encodeURIComponent,
};

for (const key of Object.keys(long)) {
  const value = long[key];
  const same =
    typeof value === "number" && Number.isNaN(value)
      ? Number.isNaN(short[key])
      : short[key] === value;
  console.log(key, same, typeof short[key]);
}

const numbers = { NaN, Infinity };
console.log(numbers.NaN !== numbers.NaN, numbers.Infinity > 1e308, -numbers.Infinity);

const ctors = { Uint8Array, Float64Array };
const bytes = new ctors.Uint8Array([1, 2, 300]);
console.log(bytes, ctors.Uint8Array.name, new ctors.Float64Array(3).length);
