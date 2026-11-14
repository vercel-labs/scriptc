// FSWatcher.ref()/unref(): both answer the watcher itself, so a listener
// registered on the returned value belongs to the same watcher, and both
// stay callable (as no-ops) once the watcher is closed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-watch-life-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "start");

const watcher = fs.watch(file, () => {});
watcher.ref().on("close", () => {
  console.log("close listener");
});
watcher.unref().ref();
watcher.close();
console.log("closed");
// A closed watcher's dropped handle makes both no-ops that still answer it.
watcher.ref();
watcher.unref();
console.log("after close");

fs.rmSync(dir, { recursive: true, force: true });
