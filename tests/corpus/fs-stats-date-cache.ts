// Stats Date members: Node's prototype getter builds the Date on the first
// read and replaces itself with an own property, so every later read of that
// Stats answers the SAME object and a mutation through it sticks (mtimeMs
// stays the raw number). Each *Ms value rounds for Stats and truncates for
// BigIntStats, exactly as Node's dateFromMs / `new Date(Number(ms))` do.
// A second stat call builds a fresh snapshot with fresh Dates.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-stats-dates-"));
const file = path.join(dir, "times.txt");
fs.writeFileSync(file, "dates\n");
// A sub-millisecond fraction separates the rounded Stats Date from the
// truncated BigIntStats one.
fs.utimesSync(file, 1700000000.0005, 1700000000.4995);

async function main(): Promise<void> {
  const stats = fs.statSync(file);
  const first = stats.mtime;
  console.log("identity:", first === stats.mtime, stats.mtime === stats.mtime);
  console.log("date value:", first.getTime(), first.getTime() === Math.round(stats.mtimeMs));
  console.log("dates distinct:", stats.mtime !== stats.atime, stats.atime !== stats.ctime);

  // A mutation through a read is visible to every later read, and the raw
  // millisecond member does not follow it.
  const rawMs = stats.mtimeMs;
  stats.mtime.setTime(0);
  console.log("mutated:", stats.mtime.getTime(), first.getTime(), stats.mtimeMs === rawMs);

  const again = fs.statSync(file);
  console.log("fresh snapshot:", again.mtime !== stats.mtime, again.mtime.getTime() === Math.round(rawMs));

  const big = fs.statSync(file, { bigint: true });
  const bigFirst = big.mtime;
  console.log("bigint identity:", bigFirst === big.mtime);
  console.log("bigint value:", bigFirst.getTime(), bigFirst.getTime() === Number(big.mtimeMs), big.mtimeNs);
  const bigRaw = big.mtimeMs;
  big.mtime.setTime(7);
  console.log("bigint mutated:", big.mtime.getTime(), big.mtimeMs === bigRaw);

  // The promise and handle forms answer the same per-object caching.
  const promised = await fsp.stat(file);
  console.log("promise:", promised.mtime === promised.mtime, promised.mtime.getTime() === Math.round(promised.mtimeMs));
  const promisedBig = await fsp.stat(file, { bigint: true });
  console.log("promise bigint:", promisedBig.mtime === promisedBig.mtime, promisedBig.mtime.getTime() === Number(promisedBig.mtimeMs));
  const handle = await fsp.open(file, "r");
  const fromHandle = await handle.stat();
  const handleBig = await handle.stat({ bigint: true });
  await handle.close();
  console.log("handle:", fromHandle.birthtime === fromHandle.birthtime, handleBig.ctime === handleBig.ctime);

  // Every Date member caches independently, and the four type tests and
  // integer members keep answering the snapshot.
  const atime = stats.atime;
  const ctime = stats.ctime;
  const birthtime = stats.birthtime;
  console.log(
    "all cached:",
    atime === stats.atime && ctime === stats.ctime && birthtime === stats.birthtime,
  );
  console.log(
    "rounded:",
    atime.getTime() === Math.round(stats.atimeMs),
    ctime.getTime() === Math.round(stats.ctimeMs),
    birthtime.getTime() === Math.round(stats.birthtimeMs),
  );
  console.log(
    "snapshot:",
    stats.isFile(),
    stats.isDirectory(),
    stats.size,
    stats.nlink,
    stats.blksize > 0,
    stats.blocks >= 0,
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

void main();
