// The number-member Stats table. Every field fs.Stats reports for a regular
// file, a directory and a symlink, with the millisecond and Date view of its
// times and the member types Node answers.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Kind = "file" | "directory" | "symlink";

function table(label: string, stats: fs.Stats, kind: Kind, exactTimes = true): void {
  console.log(
    label,
    "types",
    typeof stats.dev,
    typeof stats.mode,
    typeof stats.nlink,
    typeof stats.uid,
    typeof stats.gid,
    typeof stats.rdev,
    typeof stats.blksize,
    typeof stats.ino,
    typeof stats.size,
    typeof stats.blocks,
    typeof stats.atimeMs,
    typeof stats.mtimeMs,
    typeof stats.ctimeMs,
    typeof stats.birthtimeMs,
  );
  console.log(
    label,
    "values",
    stats.dev > 0,
    stats.mode > 0,
    stats.nlink,
    stats.uid,
    stats.gid,
    stats.rdev,
    stats.blksize,
    stats.ino > 0,
    stats.blocks >= 0,
  );
  console.log(
    label,
    "size",
    kind === "file" ? stats.size === 3 : kind === "symlink" ? stats.size === 5 : stats.size > 0,
  );
  console.log(label, "mode", (stats.mode & 0o170000).toString(8), (stats.mode & 0o777).toString(8));
  console.log(
    label,
    "times",
    stats.atime instanceof Date,
    stats.mtime instanceof Date,
    stats.ctime instanceof Date,
    stats.birthtime instanceof Date,
    exactTimes ? stats.atimeMs : "clock",
    exactTimes ? stats.atime.getTime() : "clock",
    exactTimes ? stats.mtimeMs : "clock",
    exactTimes ? stats.mtime.getTime() : "clock",
  );
  console.log(
    label,
    "clock",
    Math.trunc(stats.ctimeMs) === stats.ctimeMs,
    stats.ctimeMs > 0,
    stats.birthtimeMs > 0,
    stats.birthtimeMs <= stats.ctimeMs,
    stats.birthtime.getTime() <= stats.ctime.getTime(),
  );
  console.log(
    label,
    "predicates",
    stats.isFile(),
    stats.isDirectory(),
    stats.isSymbolicLink(),
    stats.isBlockDevice(),
    stats.isCharacterDevice(),
    stats.isFIFO(),
    stats.isSocket(),
  );
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-fields-"));
const file = path.join(dir, "f.txt");
const link = path.join(dir, "link");
fs.writeFileSync(file, "abc");
fs.utimesSync(file, 1.5, 2.25);
fs.symlinkSync("f.txt", link);

table("stat", fs.statSync(file), "file");
table("stat bigint false", fs.statSync(file, { bigint: false }), "file");
table("lstat", fs.lstatSync(file), "file");
table("lstat link", fs.lstatSync(link), "symlink", false);
table("stat dir", fs.statSync(dir), "directory", false);
const fd = fs.openSync(file, "r");
table("fstat", fs.fstatSync(fd), "file");
fs.closeSync(fd);

// The same snapshot answers both tables; the number table has no
// nanosecond companions and the values stay equal.
const big = fs.statSync(file, { bigint: true });
const small = fs.statSync(file);
console.log(
  "tables",
  BigInt(small.size) === big.size,
  BigInt(small.mode) === big.mode,
  BigInt(small.nlink) === big.nlink,
  BigInt(small.ino) === big.ino,
  BigInt(small.blocks) === big.blocks,
  BigInt(small.atimeMs) === big.atimeMs,
  BigInt(small.mtimeMs) === big.mtimeMs,
  Math.trunc(small.ctimeMs) === Number(big.ctimeMs),
  Math.trunc(small.birthtimeMs) === Number(big.birthtimeMs),
  small.atime.getTime() === Number(big.atimeMs),
  small.mtime.getTime() === Number(big.mtimeMs),
  Math.abs(small.ctime.getTime() - small.ctimeMs) < 1,
  Math.abs(small.birthtime.getTime() - small.birthtimeMs) < 1,
);
fs.rmSync(dir, { recursive: true, force: true });
