import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = fs.mkdtempSync(join(tmpdir(), "scriptc-modes-"));
const file = join(root, "file.txt");
fs.writeFileSync(file, "mode");
const missing = join(root, "missing.txt");

function show(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", String(value));
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string };
    console.log(label, e.name, e.code, String(e.message).replace(root, "<root>"));
  }
}

const perm = (path: string): number => fs.statSync(path).mode & 0o777;

// chmodSync takes a number or an octal string, and sets the exact bits.
show("chmod number", () => fs.chmodSync(file, 0o640));
console.log("chmod number bits", perm(file));
show("chmod octal string", () => fs.chmodSync(file, "600"));
console.log("chmod octal string bits", perm(file));
show("chmod zero", () => fs.chmodSync(file, 0));
console.log("chmod zero bits", perm(file));
show("chmod back", () => fs.chmodSync(file, 0o644));
console.log("chmod back bits", perm(file));

// parseFileMode's error shapes, in Node's order (path, then mode).
show("chmod bad octal", () => fs.chmodSync(file, "999"));
show("chmod empty string", () => fs.chmodSync(file, ""));
show("chmod octal overflow", () => fs.chmodSync(file, "77777777777777"));
show("chmod range", () => fs.chmodSync(file, 4294967296));
show("chmod negative", () => fs.chmodSync(file, -1));
show("chmod fraction", () => fs.chmodSync(file, 1.5));
const nul: any = null;
show("chmod null mode", () => fs.chmodSync(file, nul));
const flag: any = true;
show("chmod boolean mode", () => fs.chmodSync(file, flag));
const box: any = {};
show("chmod object mode", () => fs.chmodSync(file, box));
show("chmod missing path", () => fs.chmodSync(missing, 0o644));
show("chmod missing and bad mode", () => fs.chmodSync(missing, "999"));
console.log("chmod unchanged bits", perm(file));

// fchmodSync validates the mode before the descriptor.
const fd = fs.openSync(file, "r");
show("fchmod number", () => fs.fchmodSync(fd, 0o604));
console.log("fchmod number bits", perm(file));
show("fchmod octal string", () => fs.fchmodSync(fd, "666"));
console.log("fchmod octal string bits", perm(file));
show("fchmod bad mode", () => fs.fchmodSync(fd, "999"));
show("fchmod octal overflow", () => fs.fchmodSync(fd, "77777777777777"));
show("fchmod fraction", () => fs.fchmodSync(fd, 1.5));
show("fchmod negative fd", () => fs.fchmodSync(-1, 0o644));
show("fchmod negative fd and mode", () => fs.fchmodSync(-1, -1));
show("fchmod huge fd", () => fs.fchmodSync(2147483648, 0o644));
fs.closeSync(fd);
show("fchmod closed fd", () => fs.fchmodSync(fd, 0o644));

fs.rmSync(root, { recursive: true, force: true });
