// Static fs.writeSync: Buffer windows and utf8 strings, current-offset and
// positioned writes, byte counts, validation errors, and descriptor errors.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-2685-${process.pid}.txt`);
fs.writeFileSync(scratch, "..........");

const fd = fs.openSync(scratch, "r+");
const source = Buffer.from("abcdef", "utf8");

// Current-offset writes advance; positioned writes leave the offset alone.
console.log("buffer current:", fs.writeSync(fd, source, 1, 3, null));
console.log("buffer positioned:", fs.writeSync(fd, Buffer.from("XY"), 0, 2, 8));
console.log("string current:", fs.writeSync(fd, "é"));
console.log("string positioned:", fs.writeSync(fd, "Q", 6));
console.log("string encoded:", fs.writeSync(fd, "!", null, "utf-8"));
function evaluatedEncoding(): "utf8" {
  console.log("encoding evaluated");
  return "utf8";
}
console.log("string effectful encoding:", fs.writeSync(fd, "?", null, evaluatedEncoding()));
console.log("after positioned:", fs.writeSync(fd, Buffer.from("Z"), 0, 1, null));

// Node normalizes invalid numeric WRITE positions to the current offset
// (readSync instead rejects them). Pin both a negative and a fraction.
console.log("negative position:", fs.writeSync(fd, "N", -2));
console.log("fraction position:", fs.writeSync(fd, Buffer.from("F"), 0, 1, 1.5));
fs.closeSync(fd);

console.log("bytes:", fs.readFileSync(scratch).toString("hex"));

const offsetFd = fs.openSync(scratch, "r+");
try {
  fs.writeSync(offsetFd, source, 0.5, 1, 0);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("offset error:", err.name, err.code);
}
fs.closeSync(offsetFd);

const lengthFd = fs.openSync(scratch, "r+");
try {
  fs.writeSync(lengthFd, source, 1, 99, 0);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("length error:", err.name, err.code);
}
function logLengthError(label: string, length: number): void {
  try {
    fs.writeSync(lengthFd, source, 0, length, 0);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.message);
  }
}
// Node checks the caller window before integer-ness: values outside the
// window report its bound, while an in-range fraction reports integer.
logLengthError("length above window:", 6.5);
logLengthError("length infinite:", Infinity);
logLengthError("length negative fraction:", -0.5);
fs.closeSync(lengthFd);

const closed = fs.openSync(scratch, "r+");
fs.closeSync(closed);
try {
  fs.writeSync(closed, "x");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("fd error:", err.name, err.code);
}

fs.unlinkSync(scratch);
