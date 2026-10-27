// Buffer.from(arrayBuffer, byteOffset, length) in JavaScript, with offsets
// and lengths of every kind and an ArrayBuffer held in an untyped slot.
const ab = new ArrayBuffer(6);
new Uint8Array(ab).set([1, 2, 3, 4, 5, 6]);
const offsets = [undefined, NaN, "1", 1.5, -1, 0, 6, 7, null, true];
const lengths = [undefined, 0, -1, 2.5, "2", 6, 9, NaN, null];
for (const o of offsets) {
  for (const l of lengths) {
    try {
      const b = Buffer.from(ab, o, l);
      console.log(String(o), String(l), b, b.byteOffset, b.length);
    } catch (e) {
      const err = e;
      console.log(String(o), String(l), err.name, err.code, err.message);
    }
  }
}
const typed = Buffer.from(ab, 2, 2);
typed[0] = 99;
console.log(new Uint8Array(ab)[2], Buffer.from(ab, 4).toString("hex"), Buffer.isBuffer(Buffer.from(ab, 1, 1)));
const shared = new SharedArrayBuffer(4);
console.log(Buffer.from(shared, 1, 2).length);
const slots = { buffer: new ArrayBuffer(3) };
new Uint8Array(slots.buffer).set([9, 8, 7]);
for (const args of [[1], [1, 1], [0, 0], [3, 0], [2, 5], [-0.5, 2]]) {
  try {
    console.log(args.join(","), Buffer.from(slots.buffer, args[0], args[1]));
  } catch (e) {
    console.log(args.join(","), e.code, e.message);
  }
}
// A string's second argument is its encoding, with or without a third.
const encoded = JSON.parse('"aGk="');
console.log(
  Buffer.from(encoded, "base64", 1).toString(),
  Buffer.from(encoded, "latin1", 2).length,
  Buffer.from(encoded, undefined, 3).toString(),
  Buffer.from(encoded, "", 3).toString(),
);
for (const text of [encoded, JSON.parse('""')]) {
  try {
    console.log(Buffer.from(text, "bogus", 1));
  } catch (e) {
    console.log(e.code, e.message);
  }
}
