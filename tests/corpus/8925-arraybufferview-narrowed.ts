// A value reaches the ES library's view interface without the program ever
// naming the type: `ArrayBuffer.isView` narrows to it. The narrowed value
// reads its buffer, byte offset and byte length from the view behind it,
// whatever kind of view that is, and the buffer keeps its identity.
const backing = new ArrayBuffer(16);
const values: unknown[] = [
  new Uint8Array(backing, 2, 4),
  new Float64Array(backing, 8, 1),
  new Int16Array(backing, 4),
  new DataView(backing, 1, 7),
  Buffer.from(backing, 3, 5),
  backing,
  "text",
  { byteLength: 3 },
  null,
];

function describe(value: unknown): string {
  if (ArrayBuffer.isView(value)) {
    const same = value.buffer === backing;
    return `view offset ${value.byteOffset} length ${value.byteLength} of ${value.buffer.byteLength} same buffer ${same}`;
  }
  return `not a view (${typeof value})`;
}

for (const value of values) console.log(describe(value));

// Writes through one view are read through the buffer another view answers.
const first = values[0];
const second = values[3];
if (ArrayBuffer.isView(first) && ArrayBuffer.isView(second)) {
  new Uint8Array(first.buffer)[2] = 200;
  console.log(new Uint8Array(second.buffer, second.byteOffset, second.byteLength)[1]);
  console.log(first.buffer === second.buffer);
}

function total(views: unknown[]): number {
  let bytes = 0;
  for (const view of views) if (ArrayBuffer.isView(view)) bytes += view.byteLength;
  return bytes;
}
console.log("bytes in views:", total(values));
