// fs.watch(dir, { recursive: true }): an entry created in a subdirectory is
// delivered with its path relative to the watched root, and a directory
// created after the watch started joins the watched subtree. Each phase
// closes on its first matching event; triggers retry on an interval until it
// lands, because a platform may coalesce or defer the first delivery.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-rec-watch-"));
fs.mkdirSync(join(dir, "sub"));

function phaseNestedFile(): void {
  let fired = false;
  let watcher: fs.FSWatcher | null = null;
  watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
    if (fired || typeof filename !== "string") return;
    if (filename.replaceAll("\\", "/") !== "sub/deep.txt") return;
    fired = true;
    clearInterval(kick);
    console.log("nested file", event === "change" || event === "rename");
    if (watcher) watcher.close();
    startLaterDirectory();
  });
  let n = 0;
  const kick = setInterval(() => {
    if (fired) return;
    n += 1;
    if (n > 400) {
      console.error("nested file event never delivered");
      process.exit(1);
    }
    fs.writeFileSync(join(dir, "sub", "deep.txt"), String(n));
  }, 20);
}

function startLaterDirectory(): void {
  let fired = false;
  let watcher: fs.FSWatcher | null = null;
  watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
    if (fired || typeof filename !== "string") return;
    if (filename.replaceAll("\\", "/") !== "later/inner.txt") return;
    fired = true;
    clearInterval(kick);
    console.log("later directory", event === "change" || event === "rename");
    if (watcher) watcher.close();
    startRelativeRoot();
  });
  let n = 0;
  const kick = setInterval(() => {
    if (fired) return;
    n += 1;
    if (n > 400) {
      console.error("later directory event never delivered");
      process.exit(1);
    }
    if (n === 1) {
      fs.mkdirSync(join(dir, "later"));
    }
    fs.writeFileSync(join(dir, "later", "inner.txt"), String(n));
  }, 20);
}

// A watch started on a RELATIVE path keeps building child paths where the
// root was opened, not where the process later changes to.
function startRelativeRoot(): void {
  const relativeRoot = join(dir, "relative");
  fs.mkdirSync(relativeRoot);
  process.chdir(relativeRoot);
  let fired = false;
  let watcher: fs.FSWatcher | null = null;
  watcher = fs.watch(".", { recursive: true }, (event, filename) => {
    if (fired || typeof filename !== "string") return;
    if (filename.replaceAll("\\", "/") !== "sub/x.txt") return;
    fired = true;
    clearInterval(kick);
    process.chdir("/");
    console.log("relative root", event === "change" || event === "rename");
    if (watcher) watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("done");
  });
  process.chdir("/");
  let n = 0;
  const kick = setInterval(() => {
    if (fired) return;
    n += 1;
    if (n > 400) {
      console.error("relative-root event never delivered");
      process.exit(1);
    }
    if (n === 1) {
      fs.mkdirSync(join(relativeRoot, "sub"));
    }
    fs.writeFileSync(join(relativeRoot, "sub", "x.txt"), String(n));
  }, 20);
}

phaseNestedFile();
