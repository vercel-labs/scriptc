// fs.Stats values in arrays: Promise.all over stat() promises answers a
// Stats[] whose elements reduce, map and index like any array.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";

async function packBytes(dir: string): Promise<number | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const packs = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".pack"));
    const stats = await Promise.all(packs.map((entry) => stat(path.join(dir, entry.name))));
    return stats.reduce((total, s) => total + s.size, 0);
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const dir = path.join(tmpdir(), `scriptc-6522-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "a.pack"), "12345");
  writeFileSync(path.join(dir, "b.pack"), "123");
  writeFileSync(path.join(dir, "c.idx"), "1");
  console.log(await packBytes(dir), await packBytes(path.join(dir, "missing")));
  const all = await Promise.all(["a.pack", "c.idx"].map((name) => stat(path.join(dir, name))));
  console.log(all.length, all.map((s) => s.isFile()).join(","), all[1]!.size);
  rmSync(dir, { recursive: true, force: true });
}

main();
