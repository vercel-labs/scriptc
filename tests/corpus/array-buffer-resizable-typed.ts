// The typed surface of resizable and growable ArrayBuffers: the options
// object of `new ArrayBuffer(byteLength, { maxByteLength })` is part of the
// standard library's declarations (lib.es2024.arraybuffer/sharedmemory), so
// a TypeScript source builds the same buffer a JavaScript source does.
// maxByteLength is reserved up front, every view's length follows the owner,
// resize and grow validate against it, and transfer detaches the source.
const buffer: ArrayBuffer = new ArrayBuffer(0, { maxByteLength: 16 });
const bytes = new Uint8Array(buffer);
console.log(buffer.byteLength, buffer.maxByteLength, buffer.resizable, buffer.detached);
console.log(bytes.length);
buffer.resize(4);
bytes[1] = 7;
console.log(buffer.byteLength, bytes.length, bytes[1]);

function growTo(target: ArrayBuffer, length: number): void {
  target.resize(length);
}
growTo(buffer, 8);
console.log(bytes.length, bytes[7]);

function caught(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    if (error instanceof Error) console.log(label, error.name, error.message);
  }
}
caught("resize-too-big", () => buffer.resize(17));

const shared = new SharedArrayBuffer(2, { maxByteLength: 4 });
shared.grow(4);
console.log(shared.growable, shared.byteLength, new Uint8Array(shared).length);
caught("grow-shrink", () => shared.grow(1));

const view = new DataView(buffer);
console.log(view.byteLength);
const moved = buffer.transfer(6);
console.log(moved.byteLength, buffer.detached, moved.detached);
const fixed = moved.transferToFixedLength();
console.log(fixed.byteLength, fixed.resizable, moved.detached);
