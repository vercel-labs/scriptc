// ref() puts an unref'd watcher back on the loop: the watcher holds the
// process alive long enough for the unref'd timer (which does not hold it)
// to fire and close the watcher.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-watch-ref-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "start");

const watcher = fs.watch(file, () => {});
watcher.unref();
watcher.ref();
setTimeout(() => {
  console.log("timer");
  watcher.close();
}, 20).unref();
