// An operations record whose members may answer now or later (`Promise<T> | T`), filled by default
// with functions over node:fs/promises and awaited at the call. The stat member promises a shape
// with one function member; the default answers an fs.Stats, which must stay the Stats itself.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Operations {
  stat: (path: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  readdir: (path: string) => Promise<string[]> | string[];
}

async function statLater(path: string): Promise<Stats> {
  return stat(path);
}
function readdirLater(path: string): Promise<string[]> {
  return readdir(path);
}

const defaults: Operations = { stat: statLater, readdir: readdirLater };
const immediate: Operations = {
  stat: (path) => ({ isDirectory: () => !path.endsWith(".txt") }),
  readdir: () => ["x.txt", "y"],
};

function withDefaults(given: Partial<Operations> = {}): Operations {
  return { ...defaults, ...given };
}

async function list(dir: string, ops: Operations): Promise<string> {
  const top = await ops.stat(dir);
  if (!top.isDirectory()) return "not a directory";
  const names = await ops.readdir(dir);
  names.sort();
  const out: string[] = [];
  for (const name of names) {
    const entry = await ops.stat(join(dir, name));
    out.push(entry.isDirectory() ? `${name}/` : name);
  }
  return out.join(" ");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ops-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "a");
  const sets: [string, Operations][] = [
    ["immediate", immediate],
    ["defaults", defaults],
    ["merged", withDefaults()],
    ["merged readdir", withDefaults({ readdir: () => ["a.txt"] })],
    ["merged stat", withDefaults({ stat: () => ({ isDirectory: () => true }) })],
  ];
  for (const [name, ops] of sets) {
    try {
      console.log(name, await list(dir, ops));
    } catch (error) {
      console.log(name, "failed:", (error as Error).message);
    }
  }
  // A path that does not exist rejects with the library's own error, unchanged.
  try {
    await defaults.stat(join(dir, "missing"));
    console.log("no error");
  } catch (error) {
    const failure = error as { code?: string; syscall?: string };
    console.log("missing:", failure.code, failure.syscall, error instanceof Error);
  }
  rmSync(dir, { recursive: true });
}
main();
