// Buffer methods that take an encoding hold it in a variable: the name is
// normalized at run time with Node's tables (ASCII case and aliases), and
// each method keeps its own rule for empty and unknown names —
// Buffer.byteLength reads them as utf8, fill and write read an empty name
// as utf8 and throw ERR_UNKNOWN_ENCODING for the rest, and the string
// searches throw for both.

const enc = (name: string): BufferEncoding => name as BufferEncoding;

const report = (label: string, fn: () => unknown): void => {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, (e as Error).name, (e as Error).message);
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

// Buffer.byteLength never throws: empty and unknown names count as utf8.
for (const name of names) console.log("byteLength", name, Buffer.byteLength("héllo", enc(name)));
console.log("byteLength-default", Buffer.byteLength("héllo", enc("utf8")));

// write: the encoded bytes, the returned count, and Node's empty/unknown
// name rules.
for (const name of ["utf8", "HEX", "base64", "latin1", "ucs2", "ascii", ""]) {
  const target = Buffer.alloc(8);
  const written = target.write("6a6f", 0, 8, enc(name));
  console.log("write", name, written, target.toString("hex"));
}
report("write-unknown", () => Buffer.alloc(4).write("a", 0, 4, enc("nope")));
report("write-encoding-second", () => Buffer.alloc(4).write("a", enc("latin1")));
report("write-offset-encoding", () => Buffer.alloc(4).write("a", 1, enc("latin1")));
// The range checks run before the name is read, so a bad offset or length
// reports Node's range error even when the name is unknown too.
report("write-bad-offset-unknown", () => Buffer.alloc(4).write("a", 9, enc("nope")));
report("write-bad-length-unknown", () => Buffer.alloc(4).write("a", 0, -1, enc("nope")));

// fill: pattern repetition under each name; an empty name is utf8.
for (const name of ["utf8", "ucs2", "latin1", "ascii", "hex", "base64", ""]) {
  const filled = Buffer.alloc(6);
  filled.fill("ab", 1, 5, enc(name));
  console.log("fill", name, filled.toString("hex"));
}
report("fill-unknown", () => Buffer.alloc(4).fill("a", enc("nope")));
report("fill-encoding-second", () => Buffer.alloc(4).fill("a", enc("ucs2")).toString("hex"));
console.log("fill-offset-enc", Buffer.alloc(4).fill("ab", 2, enc("hex")).toString("hex"));
// fill reads the name before it validates the range, so an unknown name wins
// over a bad offset — the opposite of write.
report("fill-bad-offset-unknown", () => Buffer.alloc(4).fill("a", 9, enc("nope")));
report("fill-empty-value-unknown", () => Buffer.alloc(4).fill("", 0, 4, enc("nope")));
console.log("fill-empty-value", Buffer.alloc(4).fill("", 0, 4, enc("utf8")).toString("hex"));

// indexOf / lastIndexOf / includes: the needle encodes under the run-time
// name; only utf16le searches whole two-byte units.
const h = Buffer.from("abcabc");
console.log("indexOf-enc", h.indexOf("bc", enc("utf8")));
console.log("indexOf-hex", h.indexOf("6263", enc("hex")));
console.log("indexOf-base64", h.indexOf("YmM=", enc("base64")));
console.log("indexOf-offset-enc", h.indexOf("bc", 2, enc("utf8")));
console.log("lastIndexOf-enc", h.lastIndexOf("bc", enc("utf8")));
console.log("lastIndexOf-offset-enc", h.lastIndexOf("bc", 3, enc("utf8")));
console.log("includes-enc", h.includes("bc", enc("UTF8")));
console.log("includes-offset-enc", h.includes("bc", 2, enc("utf8")));
const u = Buffer.from("610062006300", "hex");
console.log("indexOf-utf16le", u.indexOf("b", enc("ucs2")), u.indexOf("b", 0, enc("UTF16LE")));
console.log("indexOf-utf16le-offset", u.indexOf("b", 2, enc("ucs2")));
console.log("contains-utf16le", u.lastIndexOf("b", enc("utf16le")), u.includes("b", enc("ucs2")));
console.log(
  "indexOf-buffer-needle",
  u.indexOf(Buffer.from("b"), enc("utf16le")),
  u.indexOf(Buffer.from("b"), 2, enc("utf16le")),
);
console.log("indexOf-buffer-needle-unknown", h.indexOf(Buffer.from("bc"), enc("nope")));
report("indexOf-unknown", () => h.indexOf("bc", enc("nope")));
report("indexOf-empty", () => h.indexOf("bc", enc("")));
report("indexOf-unknown-offset", () => h.indexOf("bc", 0, enc("nope")));
report("indexOf-empty-needle-unknown", () => h.indexOf("", enc("nope")));
console.log("indexOf-empty-needle", h.indexOf("", enc("utf8")));

// Buffer.alloc with a run-time fill encoding: Node allocates first and runs
// no fill when the size is zero, so an unknown name does not throw there.
console.log("alloc", Buffer.alloc(4, "ab", enc("hex")).toString("hex"));
console.log("alloc-empty-enc", Buffer.alloc(3, "a", enc("")).toString("hex"));
console.log("alloc-zero", Buffer.alloc(0, "a", enc("nope")).length);
report("alloc-unknown", () => Buffer.alloc(3, "a", enc("nope")));

// Buffer.from with a run-time encoding: an empty name is utf8, an unknown
// one throws.
console.log("from", Buffer.from("61", enc("hex")).toString("hex"));
console.log("from-empty", Buffer.from("ab", enc("")).toString("hex"));
report("from-unknown", () => Buffer.from("ab", enc("nope")));
// The name resolves before the empty-source early return.
report("from-empty-string-unknown", () => Buffer.from("", enc("nope")));
console.log("from-empty-string", Buffer.from("", enc("")).length);
// A zero byte count answers 0 without reading the name.
console.log("byteLength-empty-string-unknown", Buffer.byteLength("", enc("nope")));
// A non-string source reports its own byte length without reading the name.
const view: any = new Uint8Array([1, 2, 3, 4]);
console.log("byteLength-view-unknown", Buffer.byteLength(view, enc("nope")));

// An optional encoding keeps the method's default when the caller leaves it
// out; only the supplied arm is normalized.
const maybe = (name: string, use: boolean): BufferEncoding | undefined =>
  use ? enc(name) : undefined;
function writeOptional(use: boolean, name: string): string {
  const target = Buffer.alloc(6);
  const written = target.write("6a", 0, 6, maybe(name, use));
  return `${written} ${target.toString("hex")}`;
}
function fillOptional(use: boolean, name: string): string {
  return Buffer.alloc(4).fill("6a", maybe(name, use)).toString("hex");
}
function indexOfOptional(use: boolean, name: string): number {
  return Buffer.from("610062006100", "hex").indexOf("ab", maybe(name, use));
}
console.log("write-optional-absent", writeOptional(false, "nope"));
console.log("write-optional-present", writeOptional(true, "HEX"));
console.log("fill-optional-absent", fillOptional(false, "nope"));
console.log("fill-optional-present", fillOptional(true, "latin1"));
console.log("indexOf-optional-absent", indexOfOptional(false, "nope"));
console.log("indexOf-optional-present", indexOfOptional(true, "UCS2"));
console.log("byteLength-optional-absent", Buffer.byteLength("héllo", maybe("nope", false)));
report("optional-unknown", () => Buffer.alloc(4).fill("a", maybe("nope", true)));
