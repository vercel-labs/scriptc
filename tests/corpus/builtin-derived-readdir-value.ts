// fs/promises.readdir and fs.readdirSync read as values: the names listing
// their one-argument direct call is. The value keeps Node's name and one
// identity per member, enters a slot whose return is `Promise<T> | T`, calls
// through a record and a callback parameter, and rejects or throws with
// Node's error code.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface DirectoryOps {
  readdir: (absolutePath: string) => Promise<string[]> | string[];
  list: (path: string) => Promise<string[]>;
  listSync: (path: string) => string[];
}

const ops: DirectoryOps = { readdir, list: fsp.readdir, listSync: readdirSync };

console.log(
  ops.readdir === readdir,
  ops.list === fsp.readdir,
  ops.list === readdir,
  ops.listSync === readdirSync,
);
console.log(readdir.name, readdirSync.name, typeof readdir, typeof readdirSync);

const root = mkdtempSync(join(tmpdir(), "scriptc-readdir-value-"));
writeFileSync(join(root, "beta.txt"), "b");
writeFileSync(join(root, "alpha.txt"), "a");

const viaUnion = await ops.readdir(root);
console.log([...viaUnion].sort().join(","));
console.log((await ops.list(root)).length, [...ops.listSync(root)].sort().join(","));

async function count(list: (path: string) => Promise<string[]>, path: string): Promise<number> {
  return (await list(path)).length;
}
function names(list: (path: string) => string[], path: string): string {
  return [...list(path)].sort().join("|");
}
console.log(await count(readdir, root), await count(ops.list, root), names(readdirSync, root));

const missing = join(root, "missing");
try {
  await ops.list(missing);
  console.log("listed");
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code);
}
try {
  ops.listSync(missing);
  console.log("listed");
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code);
}

rmSync(root, { recursive: true, force: true });
