// A StatWatcher decides loop liveness: watchFile with persistent: false
// starts its poller unref'd, so with nothing else pending the process exits
// before the unref'd timer fires.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-stat-unref-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "start");

const watcher = fs.watchFile(file, { interval: 20, persistent: false }, () => {});
setTimeout(() => {
  console.log("timer");
  fs.unwatchFile(file);
}, 30).unref();
// unref() at the live count's zero is a no-op that still answers the record.
console.log("exiting", watcher.unref() === watcher);

fs.rmSync(dir, { recursive: true, force: true });
