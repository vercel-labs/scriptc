// FileHandle.stat(options): bigint selects BigIntStats over the same
// snapshot, and the member is read at the call as Node's getOptions does.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fh-stat-"));
  try {
    const file = join(directory, "data.txt");
    writeFileSync(file, "hello");
    const handle = await open(file, "r");
    try {
      const plain = await handle.stat();
      console.log(typeof plain.size, plain.size, plain.isFile());
      const big = await handle.stat({ bigint: true });
      console.log(typeof big.size, typeof big.mtimeNs, big.size);
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
