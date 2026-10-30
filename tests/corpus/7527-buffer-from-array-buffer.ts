// Buffer.from(arrayBuffer, byteOffset, length): Node's fromArrayBuffer over
// typed and untyped ArrayBuffers and SharedArrayBuffers: the offset and
// length conversions, the shared memory, zero and negative lengths, and
// ERR_BUFFER_OUT_OF_BOUNDS for an offset or length past the end.
const ab = new ArrayBuffer(6);
new Uint8Array(ab).set([1, 2, 3, 4, 5, 6]);
const offsets: unknown[] = [undefined, NaN, "1", 1.5, -1, 0, 6, 7, null, true];
const lengths: unknown[] = [undefined, 0, -1, 2.5, "2", 6, 9, NaN, null];
for (const o of offsets) {
  for (const l of lengths) {
    try {
      const b = Buffer.from(ab, o as number, l as number);
      console.log(String(o), String(l), b, b.byteOffset, b.length);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.log(String(o), String(l), err.name, err.code, err.message);
    }
  }
}
const typed = Buffer.from(ab, 2, 2);
typed[0] = 99;
console.log(new Uint8Array(ab)[2], Buffer.from(ab, 4).toString("hex"), Buffer.isBuffer(Buffer.from(ab, 1, 1)));
const shared = new SharedArrayBuffer(4);
console.log(Buffer.from(shared, 1, 2).length);
const loose: any = new ArrayBuffer(4);
const pairs: [unknown, unknown][] = [[1, 2], [4, undefined], [5, 1], [0, 5], ["2", "1"]];
for (const [o, l] of pairs) {
  try {
    console.log(Buffer.from(loose, o as number, l as number).toString("hex"));
  } catch (e) {
    console.log((e as NodeJS.ErrnoException).code, (e as Error).message);
  }
}
