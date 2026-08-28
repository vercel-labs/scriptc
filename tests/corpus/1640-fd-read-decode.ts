// The Node test harness's parseTestMetadata shape: allocUnsafe a scratch
// buffer, readSync a real fd into it, decode a byte window. Range decodes
// pin Node's slice-then-decode clamps: negative/oversized ends, start-only,
// start past length, and the empty collapse.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A self-made scratch file: corpus programs must not depend on host files
// (the Linux container and the Windows box lack /usr/share/dict).
const scratch = path.join(os.tmpdir(), `scr-1640-${process.pid}.txt`);
fs.writeFileSync(scratch, "0123456789abcdefghijklmnopqrstuvwxyz".repeat(6));
const buffer = Buffer.allocUnsafe(64);
const fd = fs.openSync(scratch, "r");
const bytesRead = fs.readSync(fd, buffer, 0, 64);
fs.closeSync(fd);
console.log(bytesRead === 64, buffer.length);

// A numeric position reads from that byte without advancing the fd. The
// explicit-null form then reads from (and advances) the current offset;
// the original 4-argument form observes that advance. Node also accepts -1
// as its numeric current-position sentinel.
const positioned = Buffer.alloc(5);
const first = Buffer.alloc(4);
const next = Buffer.alloc(4);
const sentinel = Buffer.alloc(2);
const parenthesizedNull = Buffer.alloc(1);
const start = 10;
const fdPositioned = fs.openSync(scratch, "r");
console.log(fs.readSync(fdPositioned, positioned, 0, 5, start), positioned.toString("utf8"));
console.log(fs.readSync(fdPositioned, first, 0, 4, null), first.toString("utf8"));
console.log(fs.readSync(fdPositioned, next, 0, 4), next.toString("utf8"));
console.log(fs.readSync(fdPositioned, sentinel, 0, 2, -1), sentinel.toString("utf8"));
console.log(
  fs.readSync(fdPositioned, parenthesizedNull, 0, 1, (null)),
  parenthesizedNull.toString("utf8"),
);
console.log(fs.readSync(fdPositioned, positioned, 0, 5, 9999));
// Node returns after intrinsic offset validation but before checking the
// buffer window, position, or descriptor when the requested window is empty.
console.log(fs.readSync(fdPositioned, positioned, 0, 0, 1.5));
console.log(fs.readSync(-123, positioned, 9999, 0, 1.5));
try {
  fs.readSync(fdPositioned, positioned, 0.5, 0, 0);
} catch (e) {
  console.log("offset caught:", (e as Error).name);
  console.log((e as Error).message);
}
try {
  fs.readSync(fdPositioned, positioned, 0, 1, 1.5);
} catch (e) {
  console.log("position caught:", (e as Error).name);
  console.log((e as Error).message);
}
fs.closeSync(fdPositioned);

const b = Buffer.from("hello world", "utf8");
console.log(b.toString("utf8", 0, 5));
console.log(b.toString("utf8", 6));
console.log(b.toString("utf8", 6, 999));
console.log(JSON.stringify(b.toString("utf8", 3, 3)));
console.log(JSON.stringify(b.toString("utf8", 4, 2)));
console.log(JSON.stringify(b.toString("utf8", 0, -1)));
console.log(JSON.stringify(b.toString("utf8", -5, 4)));
console.log(b.toString("hex", 0, 2), b.toString("base64", 0, 3));

// readSync range errors are catchable RangeErrors.
const small = Buffer.alloc(4);
const fd2 = fs.openSync(scratch, "r");
try {
  fs.readSync(fd2, small, 2, 10);
} catch (e) {
  console.log("caught:", (e as Error).name);
  console.log((e as Error).message);
}
fs.closeSync(fd2);
fs.unlinkSync(scratch);
