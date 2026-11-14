// FileHandle.chown: fchown(2) over the handle's descriptor. The open handle
// validates uid and gid with validateInteger's ladder, a closed one reports
// Node's "file closed" EBADF before reading the ids at all, and the call
// never throws synchronously.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-fh-chown-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "x");

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
        JSON.stringify(error.message.split(dir).join("<dir>")),
        (error as any).errno === undefined,
        (error as any).path === undefined,
      );
    } else {
      console.log(label, "non-error");
    }
  }
}

const handle = await fsp.open(file, "r+");
// -1 means "leave this id alone" on both systems.
await settle("open ids", () => handle.chown(-1, -1));
await settle("fractional", () => handle.chown(1.5, -1));
await settle("nan", () => handle.chown(-1, NaN));
await settle("negative", () => handle.chown(-2, -1));
await settle("gid negative", () => handle.chown(-1, -2));
await settle("too large", () => handle.chown(-1, 4294967296));
await settle("uid large", () => handle.chown(4294967296, -1));

// The handle's own closed state wins over every id check.
await handle.close();
await settle("closed", () => handle.chown(-1, -1));
await settle("closed fractional", () => handle.chown(0.5, 0));
await settle("closed negative", () => handle.chown(-2, -2));

fs.rmSync(dir, { recursive: true, force: true });
console.log("done", !fs.existsSync(dir));
