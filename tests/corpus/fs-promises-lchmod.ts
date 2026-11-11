// fs.promises.lchmod: Node reaches lchmod(2) through O_SYMLINK, which only
// macOS defines. Everywhere else the method rejects with
// ERR_METHOD_NOT_IMPLEMENTED before it reads the path or the mode at all, so
// none of the argument ladders run. The macOS form is not exercised here.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-fsp-lchmod-"));
const file = path.join(dir, "file.txt");
const link = path.join(dir, "link");
fs.writeFileSync(file, "x");
fs.symlinkSync(file, link);

async function settle(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "fulfilled");
  } catch (error) {
    if (error instanceof Error) {
      const errno = error as NodeJS.ErrnoException;
      console.log(
        label,
        error.name,
        JSON.stringify(errno.code),
        JSON.stringify(errno.syscall),
        JSON.stringify(error.message),
        (error as any).errno === undefined,
        (error as any).path === undefined,
      );
    } else {
      console.log(label, "non-error");
    }
  }
}

if (process.platform === "darwin") {
  console.log("darwin: lchmod has a real O_SYMLINK implementation");
} else {
  await settle("file", () => fsp.lchmod(file, 0o600));
  await settle("link", () => fsp.lchmod(link, 0o600));
  await settle("missing", () => fsp.lchmod(path.join(dir, "missing"), 0o600));
  // No argument ladder precedes the platform check: a fractional mode, a
  // negative mode and a NUL in the path all report the same error.
  await settle("fractional", () => fsp.lchmod(file, 1.5));
  await settle("negative", () => fsp.lchmod(file, -1));
  await settle("nul path", () => fsp.lchmod(`${dir}\0x`, 0o600));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("done", !fs.existsSync(dir));
