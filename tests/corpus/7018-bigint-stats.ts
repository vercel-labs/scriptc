// BigIntStats: `statSync(path, { bigint: true })` and its siblings answer the
// same stat snapshot under Node's bigint member table. Every number member of
// Stats — the integers, the *Ms millisecond members and the BigIntStats-only
// *Ns nanosecond members — reads as a bigint; only the four time members stay
// Dates (their getTime() is a number). The literal option selects the table,
// and throwIfNoEntry: false keeps the BigIntStats | undefined union.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const posix = process.platform !== "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigstats-"));
process.chdir(dir);
const stamp = 1700000100; // a fixed time: whole seconds, zero nanoseconds
fs.writeFileSync("data.txt", "0123456789");
fs.utimesSync("data.txt", stamp, stamp);

const st = fs.statSync("data.txt", { bigint: true });

console.log(typeof st.size, st.size, st.size === 10n);
console.log(
  typeof st.dev,
  typeof st.ino,
  typeof st.mode,
  typeof st.nlink,
  typeof st.uid,
  typeof st.gid,
  typeof st.rdev,
  typeof st.blksize,
  typeof st.blocks,
);
console.log(
  st.isFile(),
  st.isDirectory(),
  st.isSymbolicLink(),
  st.isBlockDevice(),
  st.isCharacterDevice(),
  st.isFIFO(),
  st.isSocket(),
);
console.log(typeof st.atimeMs, typeof st.mtimeNs, st.mtimeMs, st.mtimeNs);
console.log(st.mtimeNs === 1700000100000000000n, st.mtimeMs === 1700000100000n);
console.log(st.mtime instanceof Date, st.mtime.getTime() === 1700000100000);
console.log(st.mtimeMs === st.mtimeNs / 1000000n);
console.log(String(st.size), `${st.size}`, st.size + 1n, st.size * 2n, st.size.toString());

// The option literal picks the representation: omitting it is Stats.
console.log(typeof fs.statSync("data.txt").size, st.mode > 0n);
console.log(typeof fs.statSync("data.txt", { bigint: false }).size, st.mtimeNs > 0n);

// lstatSync answers the link's own snapshot, still bigint-typed.
if (posix) {
  fs.symlinkSync("data.txt", "link.txt");
  const link = fs.lstatSync("link.txt", { bigint: true });
  console.log(typeof link.size, link.size === 8n, link.isSymbolicLink(), link.isFile());
  console.log(typeof fs.lstatSync("data.txt", { bigint: true }).mtimeNs);
}

// fstatSync over an open descriptor reads the same snapshot.
const fd = fs.openSync("data.txt", "r");
const viaFd = fs.fstatSync(fd, { bigint: true });
console.log(
  typeof viaFd.size,
  viaFd.size,
  viaFd.ino === st.ino,
  viaFd.mode === st.mode,
  viaFd.mtimeNs === st.mtimeNs,
);
fs.closeSync(fd);

// throwIfNoEntry: false keeps the union: a missing entry answers undefined.
const missing = fs.statSync("missing.txt", { bigint: true, throwIfNoEntry: false });
console.log(missing === undefined);
const present = fs.statSync("data.txt", { bigint: true, throwIfNoEntry: false });
if (present !== undefined) console.log(present.size, typeof present.ino, present.isFile());

// The Date members agree with the nanosecond members.
console.log(st.atime.getTime() === Number(st.atimeNs / 1000000n));
console.log(st.ctime instanceof Date, typeof st.ctimeMs, typeof st.ctimeNs);

// A fractional millisecond of at least 0.5: Stats rounds its Date up to the
// next millisecond, while a BigIntStats Date is its truncated *Ms member.
const fractional = stamp + 0.0007;
fs.utimesSync("data.txt", fractional, fractional);
const rounded = fs.statSync("data.txt");
const truncated = fs.statSync("data.txt", { bigint: true });
console.log(rounded.mtime.getTime(), truncated.mtime.getTime(), truncated.mtimeMs);
console.log(rounded.atime.getTime() - truncated.atime.getTime());
console.log(
  truncated.atime.getTime() === Number(truncated.atimeMs),
  truncated.mtime.getTime() === Number(truncated.mtimeMs),
  truncated.ctime.getTime() === Number(truncated.ctimeMs),
  truncated.birthtime.getTime() === Number(truncated.birthtimeMs),
);

// The bigint option is evaluated like any option member: its effects run,
// in member order, before the stat, and an exception it throws is the call's.
let evaluated = "";
function note(step: string): true {
  evaluated += step;
  return true;
}
function refuse(): true {
  throw new Error("refused");
}
const counted = fs.statSync("data.txt", { bigint: note("s") });
const linked = fs.lstatSync("data.txt", { bigint: note("l") });
const byFd = fs.openSync("data.txt", "r");
const described = fs.fstatSync(byFd, { bigint: note("f") });
fs.closeSync(byFd);
console.log(evaluated, typeof counted.size, typeof linked.size, typeof described.size);
evaluated = "";
const probed = fs.statSync("missing.txt", {
  bigint: note("b"),
  throwIfNoEntry: ((evaluated += "t"), false),
});
console.log(evaluated, probed === undefined);
try {
  fs.statSync("data.txt", { bigint: refuse() });
} catch (error) {
  console.log((error as Error).message);
}
