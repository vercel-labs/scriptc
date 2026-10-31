// copyFileSync/copyFile's third argument (libuv's flag bits) and
// writeFileSync/writeFile's `flag` option ("w" and the exclusive "wx").
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, constants } from "node:fs";
import { copyFile, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-flags-"));
const src = join(dir, "src.txt");
const dst = join(dir, "dst.txt");
writeFileSync(src, "payload");
copyFileSync(src, dst, constants.COPYFILE_EXCL);
console.log(readFileSync(dst, "utf8"));
try {
  copyFileSync(src, dst, constants.COPYFILE_EXCL);
  console.log("no throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.code, err.syscall);
}
copyFileSync(src, dst);
console.log(readFileSync(dst, "utf8"));
try {
  copyFileSync(src, join(dir, "x.txt"), 8);
} catch (e) {
  const err = e as Error;
  console.log(err.name, (err as NodeJS.ErrnoException).code, err.message);
}
const wx = join(dir, "wx.txt");
writeFileSync(wx, "one", { flag: "wx" });
console.log(readFileSync(wx, "utf8"));
try {
  writeFileSync(wx, "two", { flag: "wx" });
  console.log("no throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.code, err.syscall);
}
writeFileSync(wx, "three", { flag: "w" });
console.log(readFileSync(wx, "utf8"));
const modeFile = join(dir, "mode.txt");
writeFileSync(modeFile, "m", { mode: 0o600, flag: "wx" });
console.log(readFileSync(modeFile, "utf8"));
await copyFile(src, join(dir, "p.txt"), constants.COPYFILE_EXCL);
console.log(await readFile(join(dir, "p.txt"), "utf8"));
try {
  await copyFile(src, join(dir, "p.txt"), constants.COPYFILE_EXCL);
  console.log("no throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.code, err.syscall);
}
const pwx = join(dir, "pwx.txt");
await writeFile(pwx, "async-one", { flag: "wx" });
console.log(await readFile(pwx, "utf8"));
try {
  await writeFile(pwx, "async-two", { flag: "wx" });
  console.log("no throw");
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.code, err.syscall);
}
rmSync(dir, { recursive: true, force: true });
