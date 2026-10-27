// TypedArray.of: a new array of the arguments, each converted with ToNumber
// and then to the element type, in argument order after all arguments are
// evaluated. Covers each numeric flavor and spread arguments; 6904 covers
// values that are not numbers.
const u8 = Uint8Array.of(1, 2, 3);
console.log(u8.length, u8.byteLength, Array.from(u8).join(","));
console.log(u8 instanceof Uint8Array);

console.log(Array.from(Uint8Array.of(-1, 256, 257, 3.7, 0 / 0)).join(","));
console.log(Array.from(Uint8ClampedArray.of(-1, 256, 1.5, 2.5)).join(","));
console.log(Array.from(Int8Array.of(127, 128, -129)).join(","));
console.log(Array.from(Uint16Array.of(65536, -1)).join(","));
console.log(Array.from(Int16Array.of(32768, -32769)).join(","));
console.log(Array.from(Uint32Array.of(-1, 4294967296)).join(","));
console.log(Array.from(Int32Array.of(2147483648, 1.9)).join(","));
console.log(Array.from(Float32Array.of(0.1, 1e40)).join(","));
console.log(Array.from(Float64Array.of(0.1, -0)).join(","));

const empty = Float64Array.of();
console.log("empty", empty.length);

const parts = [4, 5, 6];
console.log(Array.from(Uint8Array.of(...parts)).join(","));
console.log(Array.from(Int16Array.of(1, ...parts, 7)).join(","));

let order = "";
function next(n: number): number {
  order += n;
  return n;
}
console.log(Array.from(Uint8Array.of(next(1), next(2), next(3))).join(","), order);

const bytes = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
console.log(Buffer.from(bytes).toString("hex"));
