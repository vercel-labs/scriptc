// Two workers, each with its own recursive watch. The watch unit's wake
// source and pending deliveries are per thread, so neither worker may lose
// events (or leave them undrained) because the other started first.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function watchSubtree(dir: string): void {
  let fired = false;
  let watcher: fs.FSWatcher | null = null;
  watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
    if (fired || typeof filename !== "string") return;
    if (filename.replaceAll("\\", "/") !== "sub/x.txt") return;
    fired = true;
    clearInterval(kick);
    if (watcher) watcher.close();
    if (parentPort !== null) parentPort.postMessage("ok");
  });
  let n = 0;
  const kick = setInterval(() => {
    if (fired) return;
    n += 1;
    if (n > 400) {
      console.error("worker watch event never delivered");
      process.exit(1);
    }
    if (n === 1) {
      fs.mkdirSync(join(dir, "sub"));
    }
    fs.writeFileSync(join(dir, "sub", "x.txt"), String(n));
  }, 20);
}

if (!isMainThread) {
  watchSubtree((workerData as { dir: string }).dir);
} else {
  const root = fs.mkdtempSync(join(tmpdir(), "scr-rec-workers-"));
  const dirs = [join(root, "a"), join(root, "b")];
  for (const dir of dirs) fs.mkdirSync(dir);
  let done = 0;
  for (const dir of dirs) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { dir } });
    worker.on("message", (message: unknown) => {
      if (message !== "ok") return;
      done += 1;
      if (done === dirs.length) {
        fs.rmSync(root, { recursive: true, force: true });
        console.log("workers", done);
      }
    });
    worker.on("error", (error: Error) => {
      console.error("worker error", error.message);
      process.exit(1);
    });
  }
}
