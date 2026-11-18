// readFileSync's options.buffer: validateReadFileBufferOptions runs before
// the path is validated and the file opens, so an invalid value throws even
// with a 'w+' flag a file a valid run would truncate. A function is called
// with the file size and must answer an ArrayBufferView; a view is filled
// directly and the read answers a Buffer over the bytes it filled, sharing
// the view's memory.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-buffer-option-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello world");

function attempt(label, run) {
  try {
    const out = run();
    console.log(label, "ok", typeof out === "string" ? JSON.stringify(out) : `${out.length} ${out}`);
  } catch (error) {
    console.log(label, error.name, error.code, JSON.stringify(error.message));
  }
}

// An invalid buffer option must not open the file: 'w+' leaves the content.
for (const [label, value] of [
  ["null", null],
  ["number", 1],
  ["string", "abcd"],
  ["boolean", true],
  ["object", { length: 8 }],
  ["array", [1, 2, 3]],
  ["arraybuffer", new ArrayBuffer(8)],
]) {
  attempt(`invalid ${label}`, () => fs.readFileSync(file, { flag: "w+", buffer: value }));
  console.log("content kept", JSON.stringify(fs.readFileSync(file, "utf8")));
}

const factory = (answer) => (size) => {
  console.log("factory size", size);
  return answer(size);
};
attempt("factory undefined", () => fs.readFileSync(file, { buffer: factory(() => undefined) }));
attempt("factory number", () => fs.readFileSync(file, { buffer: factory(() => 7) }));
attempt("factory too small", () => fs.readFileSync(file, { buffer: factory((size) => Buffer.alloc(size - 1)) }));
attempt("factory exact", () => fs.readFileSync(file, { buffer: factory((size) => Buffer.alloc(size)) }));

const direct = Buffer.alloc(16, 0x2e);
const out = fs.readFileSync(file, { buffer: direct });
console.log("direct", out.length, out === direct, Buffer.isBuffer(out), out.buffer === direct.buffer);
console.log("direct memory", JSON.stringify(direct.toString()));

const backing = new ArrayBuffer(32);
const view = new Uint8Array(backing, 4, 16);
const outView = fs.readFileSync(file, { buffer: view });
console.log("view", outView.length, outView.byteOffset, outView.byteLength, outView.buffer === backing);
console.log("view memory", JSON.stringify(Buffer.from(backing).toString()));

const words = new Int32Array(4);
const outWords = fs.readFileSync(file, { buffer: words });
console.log("words", outWords.length, Array.from(words).map((word) => word.toString(16)).join(","));

const dataView = new DataView(new ArrayBuffer(32), 8, 16);
const outDataView = fs.readFileSync(file, { buffer: dataView });
console.log("dataview", outDataView.length, outDataView.byteOffset, outDataView.toString());

attempt("encoding", () => fs.readFileSync(file, { encoding: "utf8", buffer: Buffer.alloc(32) }));
attempt("encoding small", () => fs.readFileSync(file, { encoding: "utf8", buffer: Buffer.alloc(4) }));

fs.writeFileSync(file, "hello world");
const truncated = fs.readFileSync(file, { flag: "w+", buffer: Buffer.alloc(8) });
console.log("w+ valid", truncated.length, JSON.stringify(fs.readFileSync(file, "utf8")));

fs.writeFileSync(file, "");
console.log("empty", fs.readFileSync(file, { buffer: Buffer.alloc(0) }).length);
fs.rmSync(dir, { recursive: true, force: true });
