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
      // Options errors reject the promise instead of crashing the await, and
      // a closed handle rejects EBADF without reading the member at all.
      try {
        await handle.stat(null as unknown as { bigint: true });
        console.log("null options resolved");
      } catch (error) {
        console.log("null options", (error as TypeError).name);
      }
      const throwingOptions: unknown = JSON.parse("{}");
      Object.defineProperty(throwingOptions as object, "bigint", {
        get() {
          throw new Error("bigint exploded");
        },
      });
      try {
        await handle.stat(throwingOptions as { bigint: true });
        console.log("throwing resolved");
      } catch (error) {
        console.log("throwing", (error as Error).message);
      }
      const lateOptions: unknown = JSON.parse("{}");
      Object.defineProperty(lateOptions as object, "bigint", {
        get() {
          console.log("read bigint");
          return true;
        },
      });
      await handle.close();
      try {
        await handle.stat(lateOptions as { bigint: true });
        console.log("closed resolved");
      } catch (error) {
        console.log("closed", (error as NodeJS.ErrnoException).code);
      }
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
