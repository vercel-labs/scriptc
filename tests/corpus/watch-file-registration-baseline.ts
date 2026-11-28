// A change to a watched file is reported with the poller's baseline: the file
// is written with a fixed old mtime, the baseline settles over a fixed number
// of poll intervals, then the content and mtime change. The callback reports
// the previous size and mtime (the baseline) and the current size, so the
// sequence does not race the poller's initial stat.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watchfile-baseline-"));
const path = join(dir, "watched.txt");
const oldSeconds = Date.UTC(2000, 0, 1) / 1000;
const newSeconds = Date.UTC(2020, 0, 1) / 1000;

fs.writeFileSync(path, "one");
fs.utimesSync(path, oldSeconds, oldSeconds);

interface Change {
  current: number;
  previous: number;
  previousOld: boolean;
  currentNew: boolean;
}

let settle: ((change: Change) => void) | null = null;
const changed = new Promise<Change>((resolve) => {
  settle = resolve;
});

fs.watchFile(path, { interval: 20 }, (current: fs.Stats, previous: fs.Stats) => {
  if (settle !== null) {
    settle({
      current: current.size,
      previous: previous.size,
      previousOld: Math.round(previous.mtimeMs / 1000) === oldSeconds,
      currentNew: Math.round(current.mtimeMs / 1000) === newSeconds,
    });
    settle = null;
  }
});

// Five poll intervals: the baseline (the file as written above) is settled in
// every implementation before the change.
await new Promise((resolve) => setTimeout(resolve, 100));
fs.writeFileSync(path, "three!");
fs.utimesSync(path, newSeconds, newSeconds);

const sentinel: Change = { current: -1, previous: -1, previousOld: false, currentNew: false };
const change = await Promise.race([
  changed,
  new Promise<Change>((resolve) => setTimeout(() => resolve(sentinel), 2000)),
]);
console.log(`changed ${change.current} ${change.previous} old-baseline ${change.previousOld} new-current ${change.currentNew}`);
fs.unwatchFile(path);
console.log("unwatched");
fs.rmSync(dir, { recursive: true, force: true });
