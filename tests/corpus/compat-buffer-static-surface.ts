// The static Buffer surface: from over strings, arrays, views and
// array buffers, of, alloc's fill forms, allocUnsafe/allocUnsafeSlow
// lengths, concat's list and totalLength ladders, byteLength's encodings,
// isBuffer/isEncoding, and compare. Error shapes name Node's code and
// message.
import { Buffer } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

// from(string) with each encoding, and the empty and astral cases.
for (const enc of [undefined, "utf8", "hex", "base64", "base64url", "latin1", "ascii", "utf16le", "ucs2"] as const) {
  const b = Buffer.from("6162ff", enc);
  console.log(String(enc), b.length, b.toString("hex"));
}
console.log(Buffer.from("").length, Buffer.from("é").length, Buffer.from("😀").toString("hex"));
console.log(Buffer.from("aGk", "base64").toString(), Buffer.from("aGk=", "base64").toString());
console.log(Buffer.from("zz", "hex").toString("hex"), Buffer.from("a", "hex").toString("hex"));
console.log(shape(() => Buffer.from("x", "bogus" as BufferEncoding)));

// from(array): every element converts with ToUint32 & 0xff.
console.log(Buffer.from([0, 1, 255, 256, -1, 1.9, 0.5, 299]).toString("hex"));
console.log(Buffer.from([]).length);
console.log(Buffer.from(new Uint8Array([3, 4, 5])).toString("hex"));

// from(view) copies; from(arrayBuffer, offset?, length?) shares the memory.
const view = new Uint8Array([1, 2, 3]);
const fromView = Buffer.from(view);
fromView[0] = 9;
console.log(view[0], fromView.toString("hex"));
const ab = new ArrayBuffer(4);
const shared = Buffer.from(ab, 1, 2);
new Uint8Array(ab)[1] = 7;
console.log(shared.length, shared.byteOffset, shared.toString("hex"));
console.log(Buffer.from(ab, 3, 1).length, Buffer.from(ab, 4).length);
// A range past the buffer is Node's ERR_BUFFER_OUT_OF_BOUNDS.
console.log(shape(() => Buffer.from(ab, 3, 2)));
console.log(shape(() => Buffer.from(ab, 2, 10)));
console.log(shape(() => Buffer.from(new ArrayBuffer(4), 5, 1)));

// of(...items).
console.log(Buffer.of().length, Buffer.of(1, 2, 255, 256, -1).toString("hex"));

// alloc(size, fill?, encoding?).
console.log(Buffer.alloc(0).length, Buffer.alloc(4).toString("hex"));
console.log(Buffer.alloc(5, 65).toString(), Buffer.alloc(5, "ab").toString());
console.log(Buffer.alloc(5, "6162", "hex").toString(), Buffer.alloc(5, "", "utf8").toString("hex"));
console.log(Buffer.alloc(2, 300).toString("hex"), Buffer.alloc(2, -1).toString("hex"));
console.log(shape(() => Buffer.alloc(-1)));
console.log(shape(() => Buffer.alloc(1.5)));
console.log(shape(() => Buffer.alloc(2, "a", "bogus" as BufferEncoding)));

// allocUnsafe and allocUnsafeSlow answer the requested length (their bytes
// are uninitialized, so only the length and a round trip are compared).
const unsafe = Buffer.allocUnsafe(7);
unsafe.fill(0);
console.log(unsafe.length, unsafe.toString("hex"));
const slow = Buffer.allocUnsafeSlow(5);
slow.fill(1);
console.log(slow.length, slow.toString("hex"), Buffer.allocUnsafe(0).length);

// concat(list, totalLength?): the total truncates or zero-pads, and an
// invalid total is Node's ERR_OUT_OF_RANGE.
const parts = [Buffer.from("ab"), Buffer.from("cde"), Buffer.from("")];
console.log(Buffer.concat(parts).toString());
console.log(Buffer.concat(parts, 2).toString(), Buffer.concat(parts, 5).toString());
console.log(Buffer.concat(parts, 7).toString("hex"), Buffer.concat(parts, 0).length);
console.log(Buffer.concat([]).length, Buffer.concat([Buffer.alloc(0)]).length);
console.log(shape(() => Buffer.concat(parts, -1)));
console.log(shape(() => Buffer.concat(parts, 1.5)));
console.log(shape(() => Buffer.concat(parts, 0 / 0)));

// byteLength(string, encoding?) counts UTF-16 units per encoding; a view
// answers its byte length.
for (const enc of [undefined, "utf8", "latin1", "ascii", "utf16le", "hex", "base64", "base64url"] as const) {
  console.log(String(enc), Buffer.byteLength("héllo=", enc));
}
console.log(Buffer.byteLength(""), Buffer.byteLength("😀"));
console.log(Buffer.byteLength("abc", "bogus" as BufferEncoding), Buffer.byteLength("abc", "" as BufferEncoding));
console.log(Buffer.byteLength(new Uint8Array([1, 2, 3])), Buffer.byteLength(Buffer.alloc(9)));
// An ArrayBuffer, a SharedArrayBuffer, any typed array and a DataView
// answer their byte length.
console.log(Buffer.byteLength(new ArrayBuffer(4)), Buffer.byteLength(new SharedArrayBuffer(7)));
console.log(Buffer.byteLength(new Uint16Array(3)), Buffer.byteLength(new DataView(new ArrayBuffer(5))));

// isBuffer and isEncoding.
console.log(
  Buffer.isBuffer(Buffer.alloc(1)),
  Buffer.isBuffer(new Uint8Array(1)),
  Buffer.isBuffer("x"),
  Buffer.isBuffer(null),
  Buffer.isBuffer(undefined),
);
for (const name of ["utf8", "UTF-8", "utf/8", "hex", "base64url", "ucs2", "bogus", ""]) {
  console.log(name, Buffer.isEncoding(name));
}

// compare(buf1, buf2) orders lexicographically, shorter-is-smaller.
const pairs: Array<[Buffer, Buffer]> = [
  [Buffer.from("a"), Buffer.from("b")],
  [Buffer.from("b"), Buffer.from("a")],
  [Buffer.from("ab"), Buffer.from("abc")],
  [Buffer.from("abc"), Buffer.from("ab")],
  [Buffer.alloc(0), Buffer.alloc(0)],
  [Buffer.from([0xff]), Buffer.from([0])],
];
for (const [left, right] of pairs) console.log(Buffer.compare(left, right), left.compare(right));

// The module's constants.
console.log(Buffer.poolSize, Buffer.isEncoding("utf8"));
