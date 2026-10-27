// Buffer methods on Buffers held as checked-dynamic values: a buffer stored
// on `this` by a constructor function, or assigned later, keeps every
// Buffer.prototype method. The same names on other receivers keep their own.
"use strict";

function Writer(size) {
  this.buf = Buffer.alloc(size);
  this.at = 0;
}
Writer.prototype.put = function (text, encoding) {
  this.at += this.buf.write(text, this.at, encoding);
  return this;
};

const w = new Writer(12);
w.put("ab").put("6364", "hex").put("é", "latin1");
console.log(w.at, w.buf.toString("hex", 0, w.at), w.buf.toString("latin1", 0, w.at));

const t = (name, f) => {
  try {
    const v = f();
    console.log(name, Buffer.isBuffer(v) ? `<${v.toString("hex")}>` : JSON.stringify(v));
  } catch (e) {
    console.log(name, e.name, e.code, e.message);
  }
};

function Holder() {
  this.b = Buffer.from("hello world");
}
const h = new Holder();
const fresh = () => {
  h.b = Buffer.from("hello world");
  return h.b;
};

// write overloads, offset and length checks, encodings.
t("write", () => fresh() && h.b.write("HE"));
t("write offset", () => fresh() && [h.b.write("zz", 3), h.b.toString()]);
t("write offset length", () => fresh() && [h.b.write("abcdef", 1, 2), h.b.toString()]);
t("write offset encoding", () => fresh() && [h.b.write("6869", 5, "hex"), h.b.toString()]);
t("write encoding", () => fresh() && [h.b.write("aGk=", "base64"), h.b.toString()]);
t("write length encoding", () => fresh() && [h.b.write("abc", 0, 2, "latin1"), h.b.toString()]);
t("write undefined offset", () => fresh() && [h.b.write("zz", undefined, 1), h.b.toString()]);
t("write null encoding", () => fresh() && h.b.write("ab", 0, 2, null));
t("write case", () => fresh() && h.b.write("é", 0, 2, "UTF-8"));
t("write split code point", () => fresh() && h.b.write("\u{1F600}", 9));
t("write not a string", () => fresh() && h.b.write(5));
t("write unknown", () => fresh() && h.b.write("ab", 0, "nope"));
t("write numeric string offset", () => fresh() && h.b.write("ab", "1"));
t("write fractional offset", () => fresh() && h.b.write("ab", 1.5));
t("write offset past end", () => fresh() && h.b.write("ab", 12));
t("write negative length", () => fresh() && h.b.write("ab", 0, -1));
t("write number encoding", () => fresh() && h.b.write("ab", 0, 2, 5));

// fill with strings, numbers, buffers and other values.
t("fill string", () => fresh() && h.b.fill("ab", 0, 4));
t("fill number", () => fresh() && h.b.fill(0x41, 4, 6));
t("fill 300", () => fresh() && h.b.fill(300));
t("fill true", () => fresh() && h.b.fill(true, 1, 3));
t("fill object", () => fresh() && h.b.fill({}, 9));
t("fill buffer", () => fresh() && h.b.fill(Buffer.from([1, 2])));
t("fill encoding", () => fresh() && h.b.fill("ab", "utf16le"));
t("fill end encoding", () => fresh() && h.b.fill("ab", 1, "latin1"));
t("fill empty string", () => fresh() && h.b.fill("", 2));
t("fill odd hex", () => fresh() && h.b.fill("abc", "hex"));
t("fill invalid hex", () => fresh() && h.b.fill("zz", "hex"));
t("fill empty buffer", () => fresh() && h.b.fill(Buffer.alloc(0)));
t("fill number encoding", () => fresh() && h.b.fill("a", 0, 1, 5));
t("fill string offset", () => fresh() && h.b.fill(1, "2"));
t("fill end past length", () => fresh() && h.b.fill(1, 0, 20));
t("fill offset past end", () => fresh() && h.b.fill(1, 20));
t("fill empty range", () => fresh() && h.b.fill(1, 4, 2));

// toString windows and encodings.
t("toString window", () => fresh() && h.b.toString("hex", 1, 3));
t("toString numeric strings", () => fresh() && h.b.toString("utf8", "1", "3"));
t("toString fractions", () => fresh() && h.b.toString("utf8", 0.9, 2.9));
t("toString NaN", () => fresh() && h.b.toString("utf8", "x", "y"));
t("toString negative", () => fresh() && h.b.toString("utf8", -1, 2));
t("toString undefined encoding", () => fresh() && h.b.toString(undefined, 6));
t("toString empty unknown", () => fresh() && h.b.toString("nope", 3, 1));
t("toString null encoding", () => fresh() && h.b.toString(null, 0, 1));

// The other Buffer methods.
t("toJSON", () => fresh() && h.b.toJSON());
t("equals", () => fresh() && [h.b.equals(Buffer.from("hello world")), h.b.equals(Buffer.from("hello"))]);
t("equals string", () => fresh() && h.b.equals("hello world"));
t("compare", () => fresh() && [h.b.compare(Buffer.from("hellp")), h.b.compare(Buffer.from("xello"), 1, 5, 1, 5)]);
t("compare string", () => fresh() && h.b.compare("hello"));
t("copy", () => {
  const d = Buffer.alloc(4);
  return fresh() && [h.b.copy(d, 1, 6), d.toString()];
});
t("copy coerced offsets", () => {
  const d = Buffer.alloc(4);
  return fresh() && [h.b.copy(d, 1.7, "1", 3), d.toString("hex")];
});
t("copy NaN offsets", () => fresh() && h.b.copy(Buffer.alloc(2), NaN, "x"));
t("copy into Uint8Array", () => {
  const d = new Uint8Array(3);
  return fresh() && [h.b.copy(d), Array.from(d)];
});
t("copy negative target start", () => fresh() && h.b.copy(Buffer.alloc(2), -1));
t("copy source start past end", () => fresh() && h.b.copy(Buffer.alloc(2), 0, 20));
t("copy into array", () => fresh() && h.b.copy([1, 2]));
t("indexOf", () => fresh() && [h.b.indexOf("o"), h.b.indexOf("o", 5), h.b.indexOf("o", -4), h.b.indexOf(0x77)]);
t("indexOf buffer", () => fresh() && h.b.indexOf(Buffer.from("wor")));
t("indexOf encoding", () => fresh() && [h.b.indexOf("6c6c", "hex"), h.b.indexOf("l", 0, "latin1")]);
t("indexOf utf16le", () => Buffer.from("abcabc", "utf16le").indexOf("b", 0, "utf16le"));
t("indexOf unknown", () => fresh() && h.b.indexOf("l", 0, "nope"));
t("indexOf number ignores encoding", () => fresh() && h.b.indexOf(0x6c, 0, "nope"));
t("indexOf object", () => fresh() && h.b.indexOf({}));
t("lastIndexOf", () => fresh() && [h.b.lastIndexOf("o"), h.b.lastIndexOf("o", 5), h.b.lastIndexOf("l", "latin1")]);
t("lastIndexOf string offset", () => fresh() && h.b.lastIndexOf("o", "x"));
t("includes", () => fresh() && [h.b.includes("wor"), h.b.includes("z"), h.b.includes("h", null)]);
t("swap16", () => {
  h.b = Buffer.from("abcd");
  return h.b.swap16();
});
t("swap32 odd", () => {
  h.b = Buffer.from("abc");
  return h.b.swap32();
});
t("readUInt16LE", () => fresh() && h.b.readUInt16LE(1));

// A buffer assigned to a constructor-function instance after construction.
function Later() {}
const later = new Later();
later.buf = Buffer.alloc(4);
later.buf.write("cd", 1, "ascii");
console.log("later", later.buf.toString("hex"), later.buf.fill(7).toString("hex"));

// The same method names on receivers that are not Buffers.
function Box() {
  this.text = "banana";
  this.list = [1, 2, 3];
  this.bytes = new Uint8Array([5, 6, 7]);
  this.sink = { written: [], write(s) { this.written.push(s); return true; }, toString(a, b) { return `sink ${a} ${b}`; } };
}
const box = new Box();
console.log(box.text.indexOf("an"), box.text.lastIndexOf("an"), box.text.includes("nan"), box.text.toString());
console.log(box.list.indexOf(2), box.list.includes(4), box.list.fill(0, 1).join(","), box.list.toString());
console.log(Array.from(box.bytes.fill(9, 2)), box.bytes.toString());
console.log(box.sink.write("x"), box.sink.written, box.sink.toString(1, 2));

// fill with other ArrayBufferViews repeats their raw bytes; an empty view is
// ERR_INVALID_ARG_VALUE with Node's inspect of the view.
const tm = (name, f) => {
  try {
    const v = f();
    console.log(name, Buffer.isBuffer(v) ? `<${v.toString("hex")}>` : JSON.stringify(v));
  } catch (e) {
    console.log(name, e.name, e.code, JSON.stringify(e.message));
  }
};
function Held(bytes) {
  this.b = bytes;
}
const held = (bytes) => new Held(bytes).b;
const filled = (n) => held(Buffer.alloc(n));
tm("fill Uint16Array", () => filled(6).fill(new Uint16Array([0x0102])));
tm("fill DataView", () => filled(6).fill(new DataView(new Uint8Array([7, 8, 9]).buffer)));
tm("fill DataView window", () => filled(6).fill(new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)));
tm("fill Float64Array", () => filled(10).fill(new Float64Array([1])));
tm("fill subarray", () => filled(6).fill(new Uint16Array([1, 2, 3]).subarray(1)));
tm("fill Int8Array range", () => filled(6).fill(new Int8Array([-1, 2]), 1, 4));
tm("fill empty Uint16Array", () => filled(6).fill(new Uint16Array(0)));
tm("fill empty Uint8Array", () => filled(6).fill(new Uint8Array(0)));
for (const [size, offset] of [[0, 0], [1, 1], [6, 6], [7, 7], [8, 8], [120, 3], [101, 101]])
  tm(`fill empty DataView ${size}/${offset}`, () => filled(6).fill(new DataView(new ArrayBuffer(size), offset, 0)));
tm("fill empty DataView over bytes", () => filled(6).fill(new DataView(new Uint8Array(200).fill(171).buffer, 7, 0)));

// Buffer needles under utf16le search whole 2-byte units.
const units = held(Buffer.from("abcabc", "utf16le"));
const split = held(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00, 0x62, 0x00, 0x63]));
const N = (bytes) => Buffer.from(bytes);
tm("indexOf utf16le needle", () => [split.indexOf(N([0x62, 0x00]), 0, "ucs2"), split.indexOf(N([0x62, 0x00]))]);
tm("indexOf utf16le odd position", () => [
  split.indexOf(N([0x00, 0x62]), 0, "ucs2"),
  split.indexOf(N([0x00, 0x62]), 0, "UTF-16LE"),
  split.indexOf(N([0x00, 0x62])),
]);
tm("lastIndexOf utf16le needle", () => [
  units.lastIndexOf(N([0x62, 0x00]), undefined, "ucs2"),
  split.lastIndexOf(N([0x00, 0x62]), undefined, "ucs2"),
  ...[5, 3, 2, 1, -100, 100].map((at) => split.lastIndexOf(N([0x62, 0x00]), at, "ucs2")),
]);
tm("indexOf utf16le offsets", () => [1, 2, 3, -5, 7, 2.9].map((at) => split.indexOf(N([0x62, 0x00]), at, "ucs2")));
tm("indexOf utf16le short needles", () => [
  split.indexOf(N([0x62]), 0, "ucs2"),
  held(N([0x62])).indexOf(N([0x62]), 0, "ucs2"),
  split.indexOf(Buffer.alloc(0), 3, "ucs2"),
  split.indexOf(Buffer.alloc(0), 30, "ucs2"),
  split.indexOf(N([0x62, 0, 0]), 0, "ucs2"),
]);
tm("indexOf utf16le odd lengths", () => [
  held(N([1, 0, 2, 0, 3])).indexOf(N([2, 0, 3]), 0, "ucs2"),
  held(N([1, 0, 2, 0, 3, 0])).indexOf(N([2, 0, 3]), 0, "ucs2"),
  held(N([1, 2, 1, 2, 1, 2])).indexOf(N([2, 1, 2]), 0, "ucs2"),
  held(N([1, 0, 2, 0, 3])).lastIndexOf(N([3]), undefined, "ucs2"),
  held(N([0, 2, 0, 2, 0])).lastIndexOf(N([2, 0]), undefined, "ucs2"),
]);
tm("indexOf buffer needle other encodings", () => [
  split.indexOf(N([0x62, 0x00]), 0, "nope"),
  split.indexOf(N([0x00, 0x62]), 0, "nope"),
  split.indexOf(N([0x00, 0x62]), 0, "latin1"),
]);
tm("indexOf utf16le strings", () => [
  split.indexOf("b", 0, "ucs2"),
  units.lastIndexOf("b", undefined, "ucs2"),
  units.indexOf("b", 3, "ucs2"),
  units.lastIndexOf("b", 3, "ucs2"),
  units.indexOf("", 3, "ucs2"),
  units.indexOf("", 30, "ucs2"),
  units.lastIndexOf("", 30, "ucs2"),
  split.indexOf("戀", 0, "ucs2"),
]);
tm("includes utf16le needle", () => [split.includes(N([0x00, 0x62]), 0, "ucs2"), split.includes(N([0x62, 0x00]), 3, "ucs2")]);

// toString windows with infinite and out-of-range bounds.
const word = held(Buffer.from("hello"));
tm("toString infinite bounds", () => [
  word.toString("utf8", 1, Infinity),
  word.toString("utf8", -Infinity, 2),
  word.toString("utf8", Infinity),
  word.toString("utf8", NaN, 3),
  word.toString("utf8", 1e300, 2),
  word.toString("utf8", 1, 1e300),
  word.toString("utf8", -1e300, 1e300),
  word.toString("utf8", 0, -Infinity),
  word.toString("utf8", 2, NaN),
  word.toString("utf8", 0.5, 4.5),
  word.toString("hex", -0.5, -0),
  word.toString("latin1", 4.9),
  word.toString(undefined, undefined, Infinity),
]);

// The same searches and windows on Buffers the compiler types statically.
const typed = Buffer.from([0x61, 0x00, 0x62, 0x00, 0x00, 0x62, 0x00, 0x63]);
const typedUnits = Buffer.from("abcabc", "utf16le");
console.log(
  "typed utf16le",
  typed.indexOf(Buffer.from([0x00, 0x62]), 0, "ucs2"),
  Buffer.from([0x62]).indexOf(Buffer.from([0x62]), 0, "ucs2"),
  typed.lastIndexOf(Buffer.from([0x62, 0x00]), 5, "ucs2"),
  typed.indexOf(Buffer.from([0x62, 0x00]), 3, "ucs2"),
  typed.includes(Buffer.from([0x00, 0x62]), 0, "utf16le"),
  typed.indexOf("b", 0, "ucs2"),
  typedUnits.lastIndexOf("b", 100, "ucs2"),
  typedUnits.lastIndexOf("b", 3, "ucs2"),
  typedUnits.indexOf("", 30, "ucs2"),
  typedUnits.indexOf("b", 1e300, "ucs2"),
  typedUnits.indexOf("c", -1e300, "ucs2"),
);
const typedWord = Buffer.from("hello");
console.log(
  "typed windows",
  JSON.stringify([
    typedWord.toString("utf8", 1, Infinity),
    typedWord.toString("utf8", -Infinity, 2),
    typedWord.toString("utf8", Infinity),
    typedWord.toString("utf8", NaN, 3),
    typedWord.toString("utf8", 1, 1e300),
    typedWord.toString("hex", 0, -Infinity),
  ]),
);
