// fs.promises.stat/lstat with options: bigint selects BigIntStats (the same
// snapshot, read through the bigint member table). Node's stat honors
// throwIfNoEntry, so false resolves undefined for a missing path, while its
// lstat never reads it: a missing entry rejects either way.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fsp-stat-"));
  try {
    const file = join(directory, "data.txt");
    const missing = join(directory, "missing");
    writeFileSync(file, "hello");

    const big = await stat(file, { bigint: true });
    console.log(typeof big.size, typeof big.mtimeNs, typeof big.dev, big.isFile(), big.size);

    const plain = await stat(file);
    console.log(typeof plain.size, plain.size, plain.isFile(), plain.isDirectory());

    const suppressed = await stat(missing, { throwIfNoEntry: false });
    console.log(suppressed === undefined);

    // A throwIfNoEntry the checker cannot pin leaves the result
    // Stats | undefined, and the runtime reads the flag at the call.
    const flag = directory.length > 0;
    const dynamic = await stat(missing, { throwIfNoEntry: !flag });
    console.log("dynamic", dynamic === undefined);

    try {
      await stat(missing);
      console.log("no throw");
    } catch (error) {
      console.log((error as NodeJS.ErrnoException).code);
    }

    symlinkSync(file, join(directory, "link"), "file");
    const link = await lstat(join(directory, "link"), { bigint: true });
    console.log(link.isSymbolicLink(), typeof link.size, link.isFile());

    try {
      await lstat(missing, { throwIfNoEntry: false });
      console.log("lstat no throw");
    } catch (error) {
      console.log("lstat", (error as NodeJS.ErrnoException).code);
    }

    const optional = await stat(file, { bigint: true, throwIfNoEntry: false });
    console.log(typeof optional?.size, optional?.size);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
