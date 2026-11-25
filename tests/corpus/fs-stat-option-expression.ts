// A stat-family options expression whose record type pins a literal boolean
// is still evaluated: Node calls it before the stat, so its side effects and
// its exceptions are observable.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "statopts-"));
const file = path.join(root, "data.txt");
fs.writeFileSync(file, "stat options");

let calls = 0;
function bigintOptions(): { readonly bigint: true } {
  calls += 1;
  return { bigint: true };
}
const fd = fs.openSync(file, "r");
const fstat = fs.fstatSync(fd, bigintOptions());
console.log("fstat", calls, typeof fstat.size);
const stat = fs.statSync(file, bigintOptions());
console.log("stat", calls, typeof stat.size);
const lstat = fs.lstatSync(file, bigintOptions());
console.log("lstat", calls, typeof lstat.size);
fs.closeSync(fd);

function throwingOptions(): { readonly bigint: true } {
  throw new Error("options expression");
}
try {
  fs.statSync(file, throwingOptions());
} catch (error) {
  console.log("stat threw", (error as Error).message);
}
try {
  fs.fstatSync(fs.openSync(file, "r"), throwingOptions());
} catch (error) {
  console.log("fstat threw", (error as Error).message);
}

fs.rmSync(root, { recursive: true, force: true });
