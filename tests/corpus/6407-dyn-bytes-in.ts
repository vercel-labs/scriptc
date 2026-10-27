// `in` on typed arrays, Buffers and DataViews held as `any` matches Node's.
// On a typed array a canonical numeric key answers by bounds (integral,
// not -0, below the length), and "1.5", "-0", "NaN", "Infinity", "01" and
// "1e0" answer false. Other keys name members of %TypedArray%.prototype,
// Buffer.prototype for a Buffer, each constructor's BYTES_PER_ELEMENT, or
// Object.prototype. A DataView has no indexed elements and answers its own
// prototype's members.

const bytes: any = new Uint8Array([1, 2, 255]);
const floats: any = new Float64Array(2);
const buf: any = Buffer.from("ab");
for (const [label, v] of [["u8", bytes], ["f64", floats], ["buffer", buf]] as [string, any][]) {
  const keys: any[] = [0, 1, 2, 3, -1, "0", "1.5", "-0", "length", "byteLength", "buffer", "map", "set", "toString", "nope", "write"];
  console.log(label, keys.map((k) => `${String(k)}:${k in v}`).join(" "));
}
const k: any = JSON.parse("1");
console.log("computed", k in bytes, "length" in bytes, "map" in bytes);
const view: any = new DataView(new ArrayBuffer(4));
console.log("dataview", [0, "getInt8", "setUint16", "byteLength", "buffer", "length", "map", "toString"].map((k) => `${String(k)}:${k in view}`).join(" "));
const clamped: any = new Uint8ClampedArray(3);

console.log("clamped", 2 in clamped, 3 in clamped, "BYTES_PER_ELEMENT" in clamped);
const sub: any = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
console.log("subarray", 0 in sub, 1 in sub, 2 in sub);
console.log("hasOwn", Object.hasOwn(bytes, 0), Object.hasOwn(bytes, 3), Object.hasOwn(bytes, "length"), bytes.hasOwnProperty(1));
console.log("symbol", Symbol.iterator in bytes);
const empty: any = new Uint8Array(0);
console.log("empty", 0 in empty, "Infinity" in bytes, "NaN" in bytes, "1e0" in bytes, "01" in bytes);
