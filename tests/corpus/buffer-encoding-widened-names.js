// An encoding name held in a plain JavaScript variable is typed as string,
// not as a BufferEncoding literal, so the lowering cannot fold it and each
// Buffer method normalizes it at run time with Node's table. The methods
// disagree on the empty and unknown names: Buffer.byteLength counts both as
// utf8, fill and write read "" as utf8 and throw ERR_UNKNOWN_ENCODING for
// anything else, and the string searches throw for both.

const report = (label, fn) => {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, e.name, e.message);
  }
};

const names = [
  "utf8",
  "UTF8",
  "utf-8",
  "hex",
  "HEX",
  "base64",
  "BASE64",
  "base64url",
  "latin1",
  "BINARY",
  "ascii",
  "utf16le",
  "UCS2",
  "ucs-2",
  "",
  "nope",
];
for (const name of names) console.log("byteLength", JSON.stringify(name), Buffer.byteLength("héllo", name));

for (const name of ["utf8", "HEX", "base64", "latin1", "ucs2", "ascii", ""]) {
  const target = Buffer.alloc(8);
  const written = target.write("6a6f", 0, 8, name);
  console.log("write", JSON.stringify(name), written, target.toString("hex"));
}
let unknown = "nope";
let latin1 = "latin1";
let hex = "HEX";
let ucs2 = "UCS2";
report("write-unknown", () => Buffer.alloc(4).write("a", 0, 4, unknown));
report("write-encoding-second", () => Buffer.alloc(4).write("a", latin1));
report("write-offset-encoding", () => Buffer.alloc(4).write("a", 1, latin1));
report("write-bad-offset-unknown", () => Buffer.alloc(4).write("a", 9, unknown));

for (const name of ["utf8", "ucs2", "latin1", "ascii", "hex", "base64", ""]) {
  const filled = Buffer.alloc(6);
  filled.fill("ab", 1, 5, name);
  console.log("fill", JSON.stringify(name), filled.toString("hex"));
}
report("fill-unknown", () => Buffer.alloc(4).fill("a", unknown));
report("fill-encoding-second", () => Buffer.alloc(4).fill("a", latin1).toString("hex"));
console.log("fill-offset-enc", Buffer.alloc(4).fill("ab", 2, hex).toString("hex"));
report("fill-empty-value-unknown", () => Buffer.alloc(4).fill("", 0, 4, unknown));
report("fill-bad-offset-unknown", () => Buffer.alloc(4).fill("a", 9, unknown));

const h = Buffer.from("abcabc");
const u = Buffer.from("610062006300", "hex");
console.log("indexOf", h.indexOf("bc", "utf8"));
console.log("indexOf-hex", h.indexOf("6263", hex));
console.log("indexOf-offset", h.indexOf("bc", 2, "utf8"));
console.log("lastIndexOf", h.lastIndexOf("bc", "utf8"));
console.log("includes", h.includes("bc", "UTF8"));
console.log("indexOf-utf16le", u.indexOf("b", ucs2), u.indexOf("b", 0, "UTF16LE"));
console.log("indexOf-utf16le-offset", u.indexOf("b", 2, ucs2));
console.log("buffer-needle", u.indexOf(Buffer.from("b"), ucs2));
console.log("buffer-needle-unknown", h.indexOf(Buffer.from("bc"), unknown));
report("indexOf-unknown", () => h.indexOf("bc", unknown));
report("indexOf-empty", () => h.indexOf("bc", ""));
report("indexOf-unknown-offset", () => h.indexOf("bc", 0, unknown));

console.log("alloc", Buffer.alloc(4, "ab", hex).toString("hex"));
console.log("alloc-zero", Buffer.alloc(0, "a", unknown).length);
report("alloc-unknown", () => Buffer.alloc(3, "a", unknown));

console.log("from", Buffer.from("61", hex).toString("hex"));
let empty = "";
console.log("from-empty", Buffer.from("ab", empty).toString("hex"));
report("from-unknown", () => Buffer.from("ab", unknown));
report("from-empty-string-unknown", () => Buffer.from("", unknown));
console.log("byteLength-empty-string-unknown", Buffer.byteLength("", unknown));
