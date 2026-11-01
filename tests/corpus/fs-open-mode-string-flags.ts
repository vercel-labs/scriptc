// fs.openSync(path, flags, mode) with Node's string flags: the mode is the
// creation mode open(2) applies, "wx" is O_CREAT | O_EXCL, an existing file
// keeps its own mode, and an out-of-range mode throws ERR_OUT_OF_RANGE.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-open-mode-"));

const created = path.join(dir, "created.txt");
const createdFd = fs.openSync(created, "wx", 0o600);
fs.writeSync(createdFd, "created");
fs.closeSync(createdFd);
console.log("created mode:", fs.statSync(created).mode & 0o777);
console.log("created data:", fs.readFileSync(created, "utf8"));

try {
  fs.openSync(created, "wx", 0o600);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("exclusive:", err.name, err.code);
}

// An existing file keeps the mode it already has; the argument only applies
// when open(2) creates the file.
const existing = path.join(dir, "existing.txt");
fs.writeFileSync(existing, "before");
fs.chmodSync(existing, 0o644);
const existingFd = fs.openSync(existing, "w", 0o600);
fs.writeSync(existingFd, "after");
fs.closeSync(existingFd);
console.log("existing mode:", fs.statSync(existing).mode & 0o777);
console.log("existing data:", fs.readFileSync(existing, "utf8"));

// The numeric-flag form takes the same mode argument.
const numeric = path.join(dir, "numeric.txt");
const numericFd = fs.openSync(
  numeric,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  0o700,
);
fs.writeSync(numericFd, "numeric");
fs.closeSync(numericFd);
console.log("numeric mode:", fs.statSync(numeric).mode & 0o777);
console.log("numeric data:", fs.readFileSync(numeric, "utf8"));

function logModeError(label: string, mode: number): void {
  const file = path.join(dir, `bad-${label}.txt`);
  try {
    fs.openSync(file, "w", mode);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(`${label} mode:`, err.code, err.message);
  }
}
logModeError("negative", -1);
logModeError("fraction", 1.5);
logModeError("too-large", 4294967296);

fs.rmSync(dir, { recursive: true, force: true });
