// writeFileSync and appendFileSync option records: the encoding the string
// data is written with, the open(2) flag that decides truncate/append/exclusive,
// the creation mode, Buffer data with options, and the errors Node raises for
// an unknown flag or encoding.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-fs-write-options-"));
process.umask(0o022);

function hex(file: string): string {
  return fs.readFileSync(file).toString("hex");
}

function errorOf(run: () => void): string {
  try {
    run();
    return "no error";
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // The argument-validation errors name the value and key they rejected;
    // the syscall errors name the file, so their text is left out here.
    const detail = err.code === "ERR_INVALID_ARG_VALUE" ? ` ${JSON.stringify(err.message)}` : "";
    return `${err.name} ${err.code} ${err.syscall}${detail}`;
  }
}

const file = path.join(dir, "data.bin");

// Every encoding Buffer.from understands, spelled through the options record.
const encodings: string[] = [
  "utf8",
  "utf-8",
  "latin1",
  "binary",
  "ascii",
  "utf16le",
  "ucs2",
  "ucs-2",
  "base64",
  "base64url",
  "hex",
];
for (const encoding of encodings) {
  const data = encoding.startsWith("base64") ? "aGk=" : encoding === "hex" ? "6869" : "hé";
  fs.writeFileSync(file, data, { encoding: encoding as BufferEncoding });
  console.log("encoding", encoding, hex(file));
}

// The bare encoding spelling writes the same bytes.
fs.writeFileSync(file, "hé", "latin1");
console.log("bare latin1", hex(file));
fs.writeFileSync(file, "hé", "utf8");
console.log("bare utf8", hex(file));

// The flag decides what happens to an existing file.
const flags: string[] = ["w", "w+", "a", "a+", "as", "as+", "r+", "rs+"];
for (const flag of flags) {
  fs.writeFileSync(file, "first");
  const outcome = errorOf(() => fs.writeFileSync(file, "second", { flag }));
  console.log("flag", flag, outcome, hex(file));
}
for (const flag of ["wx", "wx+", "xw", "ax", "xa"]) {
  fs.writeFileSync(file, "first");
  console.log("exclusive", flag, errorOf(() => fs.writeFileSync(file, "second", { flag })), hex(file));
}
console.log("flag r on short file", errorOf(() => fs.writeFileSync(file, "x", { flag: "r" })));

// A missing file is created by the creating flags and reported by the rest.
const missing = path.join(dir, "missing.txt");
console.log("missing r", errorOf(() => fs.writeFileSync(missing, "x", { flag: "r" })), fs.existsSync(missing));
console.log("missing r+", errorOf(() => fs.writeFileSync(missing, "x", { flag: "r+" })), fs.existsSync(missing));
console.log("missing a", errorOf(() => fs.writeFileSync(missing, "x", { flag: "a" })), fs.existsSync(missing));

// Unknown flag names throw before the file is touched.
fs.writeFileSync(file, "keep");
console.log("bad flag", errorOf(() => fs.writeFileSync(file, "x", { flag: "nope" })), hex(file));
// An empty flag name is the form's default, as in Node.
console.log("empty flag", errorOf(() => fs.writeFileSync(file, "x", { flag: "" })), hex(file));

// The mode applies at creation only, like Node.
const moded = path.join(dir, "moded.txt");
fs.writeFileSync(moded, "x", { mode: 0o600 });
console.log("created mode", (fs.statSync(moded).mode & 0o777).toString(8));
fs.writeFileSync(moded, "y", { mode: 0o644 });
console.log("existing mode", (fs.statSync(moded).mode & 0o777).toString(8));

// Mode, flag and encoding together.
fs.writeFileSync(file, "a");
fs.writeFileSync(file, "é", { mode: 0o600, flag: "a", encoding: "latin1" });
console.log("combo", hex(file), (fs.statSync(file).mode & 0o777).toString(8));

// Buffer data with options: the bytes are written as they are.
fs.writeFileSync(file, Buffer.from([1, 2, 3]));
fs.writeFileSync(file, Buffer.from([4, 5]), { flag: "a" });
console.log("buffer append", hex(file));
fs.writeFileSync(file, new Uint8Array([9]), { flag: "w" });
console.log("bytes truncate", hex(file));
// The encoding is validated for Buffer data too, then ignored.
console.log(
  "buffer latin1",
  errorOf(() => fs.writeFileSync(file, Buffer.from([1, 2]), { encoding: "latin1" })),
  hex(file),
);
console.log(
  "buffer bad encoding",
  errorOf(() => fs.writeFileSync(file, Buffer.from([1, 2]), { encoding: "nope" as BufferEncoding })),
  hex(file),
);

// appendFileSync's options record and bare encoding.
const appended = path.join(dir, "append.txt");
fs.appendFileSync(appended, "one");
fs.appendFileSync(appended, "two", { encoding: "utf8" });
fs.appendFileSync(appended, "é", { encoding: "latin1" });
fs.appendFileSync(appended, "+", "latin1");
console.log("append", fs.readFileSync(appended, "utf8"), hex(appended));
fs.appendFileSync(appended, Buffer.from([0x21]));
console.log("append buffer", hex(appended));
fs.appendFileSync(appended, Buffer.from([0x3f]), { encoding: "hex" });
console.log("append buffer encoding", hex(appended));
fs.appendFileSync(appended, "w", { flag: "w" });
console.log("append flag w", hex(appended));
console.log("append flag wx", errorOf(() => fs.appendFileSync(appended, "x", { flag: "wx" })));

// Errors keep Node's shapes: a directory, a missing parent, a bad flag.
console.log("append dir", errorOf(() => fs.appendFileSync(dir, "x")));
console.log("append missing parent", errorOf(() => fs.appendFileSync(path.join(dir, "no", "f"), "x")));
console.log("append bad flag", errorOf(() => fs.appendFileSync(appended, "x", { flag: "nope" })));
console.log("append bad encoding", errorOf(() => fs.appendFileSync(appended, "x", { encoding: "nope" as BufferEncoding })));

// Undocumented option keys are ignored, as in Node.
fs.writeFileSync(file, "k", { nosuchkey: 1 } as { mode?: number });
console.log("unknown key", hex(file));
