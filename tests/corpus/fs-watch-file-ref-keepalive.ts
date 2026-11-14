// ref() puts an unref'd StatWatcher back on the loop, and the counters keep
// it there until the live count reaches zero: a second call on the same path
// raises both counts, so one unref() leaves the poller ref'd while the next
// unref() lets the loop drain.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-stat-ref-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "start");

// The unref'd poller holds the loop again after ref(), up to the live
// count's zero.
const watcher = fs.watchFile(file, { interval: 20, persistent: false }, () => {});
watcher.ref();
// A second call ignores its options, which here would have thrown.
fs.watchFile(file, { interval: -1 }, () => {});
watcher.unref();
setTimeout(() => {
  console.log("held through the counters");
  watcher.unref();
  fs.rmSync(dir, { recursive: true, force: true });
}, 30).unref();
console.log("waiting");
