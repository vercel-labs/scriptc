// The BigIntStats member table: every number member of Stats answers a
// bigint, the four *Ns members sit beside them, and the Date members stay
// Dates whose getTime() answers a number. statSync, lstatSync, fstatSync and
// the fstat callback all build the same table from the same snapshot.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-big-"));
const file = path.join(dir, "f.txt");
const link = path.join(dir, "link");
fs.writeFileSync(file, "abc");
fs.utimesSync(file, 1.5, 2.25);
fs.symlinkSync("f.txt", link);

function table(label: string, stats: fs.BigIntStats, exactTimes = true): void {
  console.log(
    label,
    "types",
    [
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
      typeof stats.atimeNs,
      typeof stats.mtimeNs,
      typeof stats.ctimeNs,
      typeof stats.birthtimeNs,
    ].join(","),
  );
  console.log(
    label,
    "values",
    stats.dev > 0n,
    stats.mode > 0n,
    stats.nlink,
    stats.uid >= 0n,
    stats.gid >= 0n,
    stats.rdev >= 0n,
    stats.blksize > 0n,
    stats.ino > 0n,
    stats.size,
    stats.blocks >= 0n,
    stats.atimeMs > 0n,
    stats.mtimeMs > 0n,
    stats.atimeNs > 0n,
    stats.mtimeNs > 0n,
    stats.mtimeMs === stats.mtimeNs / 1000000n,
    stats.ctimeMs === stats.ctimeNs / 1000000n,
    stats.birthtimeMs === stats.birthtimeNs / 1000000n,
  );
  if (exactTimes)
    console.log(
      label,
      "times",
      stats.atimeMs === 1500n,
      stats.mtimeMs === 2250n,
      stats.atimeNs === 1500000000n,
      stats.mtimeNs === 2250000000n,
    );
  console.log(
    label,
    "dates",
    stats.atime instanceof Date,
    stats.mtime instanceof Date,
    stats.ctime instanceof Date,
    stats.birthtime instanceof Date,
    stats.atime.getTime() > 0,
    stats.mtime.getTime() > 0,
    typeof stats.atime.getTime(),
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

table("stat", fs.statSync(file, { bigint: true }));
table("lstat", fs.lstatSync(file, { bigint: true }));
table("lstat link", fs.lstatSync(link, { bigint: true }), false);

const fd = fs.openSync(file, "r");
table("fstat", fs.fstatSync(fd, { bigint: true }));
fs.fstat(fd, { bigint: true }, (error, stats) => {
  console.log("fstat callback error", error);
  table("fstat callback", stats);
  fs.closeSync(fd);
  fs.rmSync(dir, { recursive: true, force: true });
});
