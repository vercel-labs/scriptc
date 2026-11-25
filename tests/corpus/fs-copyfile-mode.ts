// fs.copyFileSync gives the destination the source's mode, including its
// executable bits, for an existing destination and a newly created one.
// The X_OK probe is the idiom that reports the divergence: Node passes it,
// a destination left with its old mode throws EACCES.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-copyfile-mode-"));
const src = path.join(dir, "src.txt");
fs.writeFileSync(src, "source");
fs.chmodSync(src, 0o755);

// An existing destination takes the source's mode.
const dst = path.join(dir, "dst.txt");
fs.writeFileSync(dst, "destination");
fs.copyFileSync(src, dst);
console.log("existing mode:", fs.statSync(dst).mode & 0o777);
console.log("existing data:", fs.readFileSync(dst, "utf8"));
fs.accessSync(dst, fs.constants.X_OK);
console.log("existing executable: true");

// A destination the copy creates is created with the source's mode.
const fresh = path.join(dir, "fresh.txt");
fs.copyFileSync(src, fresh);
console.log("fresh mode:", fs.statSync(fresh).mode & 0o777);
console.log("fresh data:", fs.readFileSync(fresh, "utf8"));

// A plain file source drops the destination's executable bits.
const plain = path.join(dir, "plain.txt");
fs.writeFileSync(plain, "plain");
fs.chmodSync(plain, 0o644);
const exe = path.join(dir, "exe.txt");
fs.writeFileSync(exe, "exe");
fs.chmodSync(exe, 0o755);
fs.copyFileSync(plain, exe);
console.log("plain mode:", fs.statSync(exe).mode & 0o777);
console.log("plain data:", fs.readFileSync(exe, "utf8"));

// Copying a file onto itself succeeds and leaves the contents alone.
fs.copyFileSync(src, src);
console.log("self data:", fs.readFileSync(src, "utf8"));

// COPYFILE_EXCL still refuses an existing destination.
try {
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("exclusive:", err.name, err.code);
}

fs.rmSync(dir, { recursive: true, force: true });
