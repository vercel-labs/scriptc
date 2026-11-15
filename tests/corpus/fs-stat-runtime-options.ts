// The stat family's run-time options: when the compiler cannot pin bigint or
// throwIfNoEntry (a parameter, a stored record with widened members, a JSON
// value), statSync/lstatSync/fstatSync read them at the call — bigint picks
// the member table, throwIfNoEntry the missing-entry answer.
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { StatSyncOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fs-stat-rt-"));
const file = join(dir, "f.txt");
const missing = join(dir, "nope");
const link = join(dir, "link");
writeFileSync(file, "hello");
symlinkSync(file, link);

interface StatOptions {
  bigint: boolean;
  throwIfNoEntry: boolean;
}

function read(path: string, options: StatOptions): string {
  const stats = statSync(path, options);
  if (stats === undefined) return "undefined";
  return [typeof stats.size, stats.isFile(), stats.isDirectory()].join(" ");
}
console.log("stat", read(file, { bigint: false, throwIfNoEntry: true }));
console.log("stat big", read(file, { bigint: true, throwIfNoEntry: true }));

function readLink(path: string, options: StatOptions): string {
  const stats = lstatSync(path, options);
  if (stats === undefined) return "undefined";
  return [typeof stats.size, stats.isFile(), stats.isSymbolicLink()].join(" ");
}
console.log("lstat", readLink(link, { bigint: false, throwIfNoEntry: false }));
console.log("lstat big", readLink(link, { bigint: true, throwIfNoEntry: false }));

function readMissing(path: string, options: StatOptions): string {
  const stats = statSync(path, options);
  return stats === undefined ? "undefined" : "stats";
}
console.log("suppressed", readMissing(missing, { bigint: false, throwIfNoEntry: false }));
try {
  readMissing(missing, { bigint: false, throwIfNoEntry: true });
} catch (e) {
  const err = e as Error & { code?: string; syscall?: string };
  console.log("throws", err.code, err.syscall);
}

function readFd(fd: number, bigint: boolean): string {
  const stats = fstatSync(fd, { bigint });
  return [typeof stats.size, stats.isFile()].join(" ");
}
const fd = openSync(file, "r");
console.log("fstat", readFd(fd, false));
console.log("fstat big", readFd(fd, true));
closeSync(fd);

// The member table the call chose: number fields against bigint ones.
function fieldTypes(path: string, bigint: boolean): string {
  const stats = statSync(path, { bigint });
  if (stats === undefined) return "undefined";
  return [
    typeof stats.size,
    typeof stats.mode,
    typeof stats.mtimeMs,
    typeof stats.blocks,
    stats.atime instanceof Date,
  ].join(",");
}
console.log("fields", fieldTypes(file, false));
console.log("fields big", fieldTypes(file, true));

// An options record only the runtime fills: the ladder reads bigint off it
// at the call, and an absent throwIfNoEntry keeps Node's throwing default.
interface ParsedOptions {
  bigint: boolean;
  throwIfNoEntry?: boolean;
}
const parsed: ParsedOptions = JSON.parse('{"bigint": true}');
const parsedStats = statSync(file, parsed);
console.log("parsed big", parsedStats === undefined ? "undefined" : typeof parsedStats.size);
const linkOptions: ParsedOptions = JSON.parse('{"bigint": true, "throwIfNoEntry": false}');
const stillBig = lstatSync(link, linkOptions);
console.log("parsed lstat", stillBig === undefined ? "undefined" : typeof stillBig.size);

// Null options fail on the first member read Node makes.
try {
  statSync(file, null as unknown as StatSyncOptions);
} catch (e) {
  const err = e as Error & { name?: string };
  console.log("null options", err.name, err.message);
}

rmSync(dir, { recursive: true, force: true });
