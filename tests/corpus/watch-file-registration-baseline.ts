// A change written immediately after fs.watchFile returns is reported: the
// baseline is the file at registration, as Node's StatWatcher start takes it.
// The poller reports (current, previous) sizes and the program stops watching.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watchfile-baseline-"));
const path = join(dir, "watched.txt");
fs.writeFileSync(path, "one");

interface Change {
  current: number;
  previous: number;
}

let settle: ((change: Change) => void) | null = null;
const changed = new Promise<Change>((resolve) => {
  settle = resolve;
});

fs.watchFile(path, { interval: 20 }, (current: fs.Stats, previous: fs.Stats) => {
  if (settle !== null) {
    settle({ current: current.size, previous: previous.size });
    settle = null;
  }
});

fs.writeFileSync(path, "three!");
const change = await Promise.race([
  changed,
  new Promise<Change>((resolve) => setTimeout(() => resolve({ current: -1, previous: -1 }), 2000)),
]);
console.log(`changed ${change.current} ${change.previous}`);
fs.unwatchFile(path);
console.log("unwatched");
fs.rmSync(dir, { recursive: true, force: true });
