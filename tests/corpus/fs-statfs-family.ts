// The filesystem-capacity snapshot: statfsSync and the statfs callback
// answer the number table by default and the bigint table with
// { bigint: true }, each with Node's eight members including frsize, and
// report the same errno shape for a missing path.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statfs-family-"));
const missing = path.join(dir, "missing");

function numberTable(label: string, stats: fs.StatsFs): void {
  console.log(
    label,
    [
      typeof stats.type,
      typeof stats.bsize,
      typeof stats.frsize,
      typeof stats.blocks,
      typeof stats.bfree,
      typeof stats.bavail,
      typeof stats.files,
      typeof stats.ffree,
    ].join(","),
  );
  console.log(
    label,
    "relations",
    stats.type > 0,
    stats.bsize > 0,
    stats.frsize > 0,
    stats.frsize === stats.bsize,
    stats.blocks >= stats.bfree && stats.bfree >= stats.bavail,
    stats.files >= stats.ffree,
    Number.isInteger(stats.bsize),
  );
}

function bigintTable(label: string, stats: fs.BigIntStatsFs): void {
  console.log(
    label,
    [
      typeof stats.type,
      typeof stats.bsize,
      typeof stats.frsize,
      typeof stats.blocks,
      typeof stats.bfree,
      typeof stats.bavail,
      typeof stats.files,
      typeof stats.ffree,
    ].join(","),
  );
  console.log(
    label,
    "relations",
    stats.type > 0n,
    stats.bsize > 0n,
    stats.frsize > 0n,
    stats.blocks >= stats.bfree && stats.bfree >= stats.bavail,
    stats.files >= stats.ffree,
  );
}

const small = fs.statfsSync(dir);
const big = fs.statfsSync(dir, { bigint: true });
numberTable("sync", small);
bigintTable("sync bigint", big);
console.log(
  "sync tables",
  big.type === BigInt(small.type),
  big.bsize === BigInt(small.bsize),
  big.frsize === BigInt(small.frsize),
  big.blocks === BigInt(small.blocks),
  big.bfree >= 0n && big.bfree <= big.blocks,
  big.bavail >= 0n && big.bavail <= big.bfree,
  big.files >= big.ffree,
  big.ffree >= 0n,
);
numberTable("sync false", fs.statfsSync(dir, { bigint: false }));

const file = path.join(dir, "f.txt");
fs.writeFileSync(file, "abc");
console.log("file", fs.statfsSync(file).bsize > 0, fs.statfsSync(file).frsize > 0);

try {
  fs.statfsSync(missing);
} catch (error) {
  console.log("sync missing", (error as NodeJS.ErrnoException).code, (error as NodeJS.ErrnoException).syscall, (error as Error).message.includes("statfs"));
}
try {
  fs.statfsSync(missing, { bigint: true });
} catch (error) {
  console.log("sync bigint missing", (error as NodeJS.ErrnoException).code, (error as NodeJS.ErrnoException).syscall);
}

fs.statfs(dir, (error, stats) => {
  console.log("callback error", error);
  numberTable("callback", stats);
  fs.statfs(dir, { bigint: true }, (bigError, bigStats) => {
    console.log("callback bigint error", bigError);
    bigintTable("callback bigint", bigStats);
    fs.statfs(missing, (missingError) => {
      const failure = missingError as NodeJS.ErrnoException;
      console.log("callback missing", failure.code, failure.syscall, (failure as Error).message.includes("statfs"));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
