// Builtin module functions that had no hand-written value contract read as
// values through the same lowering their direct calls use: the value keeps
// Node's name, one identity per member across import spellings, and it
// calls, awaits and passes as a callback like the direct call.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat, realpath, lstat } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Ops {
  stat: (path: string) => Promise<Stats>;
  lstat: (path: string) => Promise<Stats>;
  realpath: (path: string) => Promise<string>;
  mkdtemp: (prefix: string) => string;
}

const ops: Ops = { stat, lstat, realpath, mkdtemp: mkdtempSync };

console.log(
  ops.stat === stat,
  ops.stat === fsp.stat,
  ops.lstat === fsp.lstat,
  ops.realpath === fsp.realpath,
  ops.mkdtemp === mkdtempSync,
);
console.log(stat.name, lstat.name, realpath.name, mkdtempSync.name);

const root = ops.mkdtemp(join(tmpdir(), "scriptc-derived-values-"));
const file = join(root, "entry.txt");
writeFileSync(file, "derived");
const snapshot: Stats = await ops.stat(root);
console.log(snapshot.isDirectory(), snapshot.isFile());

async function isDirectory(fn: (path: string) => Promise<Stats>, path: string): Promise<boolean> {
  return (await fn(path)).isDirectory();
}
console.log(await isDirectory(ops.stat, root));
console.log(await isDirectory(fsp.lstat, root));

const resolved = await ops.realpath(root);
console.log(typeof resolved, resolved.endsWith(root.slice(root.lastIndexOf("/"))));

const statRef: (path: string) => Promise<Stats> = fsp.stat;
console.log(statRef === ops.stat, await isDirectory(statRef, file));

rmSync(root, { recursive: true, force: true });
console.log(existsSync(root));
