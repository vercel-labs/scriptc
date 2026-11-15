// fs.Dirent entries from a typed directory read (name, parentPath and the
// kind predicates), and fs.realpathSync.native, with the error a missing
// directory reports.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(realpathSync(tmpdir()), "compat-dirent-"));
writeFileSync(join(dir, "f.txt"), "x");
mkdirSync(join(dir, "sub"));
symlinkSync(join(dir, "f.txt"), join(dir, "link"));

const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
for (const entry of entries) {
  console.log(entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink(), entry.parentPath === dir);
}
console.log(realpathSync.native(join(dir, "link")) === join(dir, "f.txt"), realpathSync.native(dir) === dir);

try {
  readdirSync(join(dir, "missing"), { withFileTypes: true });
} catch (e) {
  const err = e as Error & { code?: string; syscall?: string; path?: string };
  console.log(err.code, err.syscall, err.path === join(dir, "missing"));
}
try {
  realpathSync.native(join(dir, "missing"));
} catch (e) {
  const err = e as Error & { code?: string; syscall?: string };
  console.log(err.code, err.syscall);
}
rmSync(dir, { recursive: true });
