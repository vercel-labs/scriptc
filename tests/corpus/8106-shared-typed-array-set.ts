// TypedArray.prototype.set where the source, the target or both are views of
// a SharedArrayBuffer: same element kinds (bytes copied as is, NaN payloads
// included), different kinds (converted per element), offsets, overlapping
// ranges of one buffer, Buffer targets and out-of-bounds offsets.
function bits(label: string, buffer: ArrayBufferLike): void {
  const words = new Uint32Array(buffer);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) out.push(words[i]!.toString(16));
  console.log(label, out.join(","));
}

const shared = new SharedArrayBuffer(32);
const bytes = new Uint8Array(shared);

// Private source into a shared target, then shared into shared and shared into private.
bytes.set(new Uint8Array([1, 2, 3, 4, 5]), 2);
console.log("private into shared", bytes.subarray(0, 8).join(","));
const other = new Uint8Array(new SharedArrayBuffer(8));
other.set(bytes.subarray(2, 7));
console.log("shared into shared", other.join(","));
const local = new Uint8Array(12);
local.set(other, 3);
console.log("shared into private", local.join(","));

// Overlapping ranges of the same buffer, forward and backward.
const overlap = new Uint8Array(new SharedArrayBuffer(10));
overlap.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
overlap.set(overlap.subarray(0, 6), 3);
console.log("overlap forward", overlap.join(","));
overlap.set(overlap.subarray(4, 10), 1);
console.log("overlap backward", overlap.join(","));

// Same kind, wider elements: a signaling NaN keeps its bits.
const floatBits = new Uint32Array(new SharedArrayBuffer(8));
floatBits[0] = 0x7fa00001;
floatBits[1] = 0xffc00002;
const floatsShared = new Float32Array(floatBits.buffer);
const floatsLocal = new Float32Array(2);
floatsLocal.set(floatsShared);
bits("f32 shared into private", floatsLocal.buffer);
const floatsBack = new Float32Array(new SharedArrayBuffer(8));
floatsBack.set(floatsLocal);
bits("f32 private into shared", floatsBack.buffer);

const doubleBits = new Uint32Array(new SharedArrayBuffer(16));
doubleBits[0] = 5;
doubleBits[1] = 0x7ff40000;
doubleBits[2] = 0;
doubleBits[3] = 0xc0090000;
const doublesShared = new Float64Array(doubleBits.buffer);
const doublesCopy = new Float64Array(new SharedArrayBuffer(16));
doublesCopy.set(doublesShared);
bits("f64 shared into shared", doublesCopy.buffer);
console.log("f64 values", doublesCopy[1]);

const signed = new Int16Array(new SharedArrayBuffer(8));
signed.set(new Int16Array([-32768, -1, 32767]), 1);
console.log("i16 private into shared", signed.join(","));

// Different kinds convert each element.
const clamped = new Uint8ClampedArray(new SharedArrayBuffer(4));
clamped.set(new Int16Array([300, -5, 128, 255]));
console.log("i16 into shared clamped", clamped.join(","));
const wrapped = new Uint8Array(new SharedArrayBuffer(4));
wrapped.set(new Int16Array(signed.buffer, 2, 3));
console.log("shared i16 into shared u8", wrapped.join(","));
const narrowed = new Int8Array(4);
narrowed.set(new Float64Array(doublesShared.buffer, 8, 1));
narrowed.set(new Uint8Array([200, 127]), 2);
console.log("f64 and u8 into i8", narrowed.join(","));
const fromClamped = new Uint8Array(new SharedArrayBuffer(4));
fromClamped.set(clamped);
console.log("shared clamped into shared u8", fromClamped.join(","));

// Buffer views over shared memory take the same paths.
const buf = Buffer.from(shared, 16, 8);
buf.set(Buffer.from("scriptc"), 1);
console.log("buffer", buf.toString("latin1", 1, 8), bytes[17], bytes[23]);
const into = Buffer.alloc(4);
into.set(buf.subarray(1, 4));
console.log("buffer into private", into.toString("hex"));

// Offsets past the end throw before writing.
for (const offset of [-1, 30, 31]) {
  try {
    bytes.set(new Uint8Array([9, 9]), offset);
    console.log("set at", offset, bytes[30], bytes[31]);
  } catch (error) {
    console.log("set at", offset, (error as Error).name, (error as Error).message);
  }
}
try {
  floatsBack.set(new Float32Array(3));
} catch (error) {
  console.log("too long", (error as Error).name, (error as Error).message);
}
console.log("unchanged", floatsBack.join(","));
