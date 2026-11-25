// A Stats object whose member table the call chose at run time: bigint
// selects the BigIntStats members and their *Ns companions, any other
// truthiness keeps the number members, and every member reads off the
// object the call answered. The field values are the same snapshot either
// way.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-tables-'));
const file = path.join(dir, "f.txt");
const link = path.join(dir, "link");
fs.writeFileSync(file, "abc");
fs.utimesSync(file, 1.5, 2.25);
fs.symlinkSync("f.txt", link);

const describe = (label, stats, exactTimes = true) => {
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
    "ns",
    stats.atimeNs === undefined,
    exactTimes ? stats.atimeNs : stats.atimeNs > 0n,
    exactTimes ? stats.mtimeNs : stats.mtimeNs > 0n,
    stats.ctimeNs > 0n,
    stats.birthtimeNs > 0n,
  );
  console.log(
    label,
    "values",
    stats.dev > 0,
    stats.mode > 0,
    stats.nlink,
    stats.blksize > 0,
    stats.ino > 0,
    stats.size,
    stats.blocks >= 0,
    stats.atimeMs === 1500,
    stats.mtimeMs === 2250,
    stats.mtimeMs === Math.round(stats.mtime.getTime()),
  );
  console.log(
    label,
    "dates",
    stats.atime instanceof Date,
    stats.mtime instanceof Date,
    stats.ctime instanceof Date,
    stats.birthtime instanceof Date,
    exactTimes ? stats.atime.getTime() : "clock",
    exactTimes ? stats.mtime.getTime() : "clock",
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
};

const options = (json) => JSON.parse(json);
describe("stat bigint", fs.statSync(file, options('{"bigint": true}')));
describe("stat number", fs.statSync(file, options('{"bigint": false}')));
describe("lstat bigint", fs.lstatSync(file, options('{"bigint": true}')));
describe("lstat link", fs.lstatSync(link, options('{"bigint": 0}')), false);
const fd = fs.openSync(file, "r");
describe("fstat number", fs.fstatSync(fd, options('{"bigint": false}')));
fs.closeSync(fd);
const missing = path.join(dir, "missing");
console.log(
  "missing",
  fs.statSync(missing, options('{"bigint": true, "throwIfNoEntry": false}')),
  fs.lstatSync(missing, options('{"bigint": false, "throwIfNoEntry": false}')),
);
fs.rmSync(dir, { recursive: true, force: true });
