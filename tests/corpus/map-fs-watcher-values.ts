// A Map keyed by path whose values are fs.FSWatcher handles (the watcher
// registry idiom). The handle is an ordinary refcounted value: it stores,
// reads back by identity, iterates with its key, and closes.
import * as fs from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-map-watcher-"));
const watchers = new Map<string, FSWatcher>();
const watcher = fs.watch(dir, () => {});
watchers.set(dir, watcher);

console.log("size", watchers.size, "has", watchers.has(dir));
console.log("identity", watchers.get(dir) !== undefined);
let entries = 0;
for (const [path, handle] of watchers) {
  entries++;
  console.log("entry", path === dir);
  handle.close();
}
console.log("entries", entries, "still stored", watchers.get(dir) !== undefined);
fs.rmSync(dir, { recursive: true, force: true });
