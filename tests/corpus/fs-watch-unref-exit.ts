// An unref'd watcher does not hold the event loop: with nothing else
// pending the process exits before the unref'd timer fires.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-watch-unref-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "start");

const watcher = fs.watch(file, () => {
  console.log("event");
});
watcher.unref();
setTimeout(() => {
  console.log("timer");
  watcher.close();
}, 50).unref();
console.log("exiting");

fs.rmSync(dir, { recursive: true, force: true });
