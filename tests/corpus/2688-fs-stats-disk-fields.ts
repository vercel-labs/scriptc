// Stats.blocks/nlink/atimeMs across path stat, promise stat, lstat, and
// FileHandle.stat. blocks is Node's 512-byte allocation count (the disk-usage
// idiom); timestamp facts stay bounded because the two differential sides use
// distinct scratch files created at slightly different instants.
import {
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-stats-fields-"));
const file = join(dir, "allocated.txt");
writeFileSync(file, "disk usage\n");

const now = Date.now();
const syncStats = statSync(file);
console.log(
  "sync:",
  syncStats.blocks,
  syncStats.blocks * 512 >= syncStats.size,
  syncStats.nlink,
  syncStats.atimeMs > 0,
  syncStats.atimeMs <= now + 60_000,
);

async function main(): Promise<void> {
  const promiseStats = await stat(file);
  console.log(
    "promise:",
    promiseStats.blocks === syncStats.blocks,
    promiseStats.nlink === syncStats.nlink,
    promiseStats.atimeMs === syncStats.atimeMs,
  );

  const linkStats = lstatSync(file);
  console.log(
    "lstat:",
    linkStats.blocks === syncStats.blocks,
    linkStats.nlink === syncStats.nlink,
    linkStats.atimeMs === syncStats.atimeMs,
  );

  const handle = await open(file, "r");
  const handleStats = await handle.stat();
  console.log(
    "handle:",
    handleStats.blocks === syncStats.blocks,
    handleStats.nlink === syncStats.nlink,
    handleStats.atimeMs === syncStats.atimeMs,
  );
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
}

void main();
