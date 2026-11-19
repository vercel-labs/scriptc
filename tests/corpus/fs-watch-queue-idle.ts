// A thread that closed its only recursive watch must not deliver events
// gathered while it had none. The worker below watches a directory, closes
// the watcher, waits while the main thread (which keeps its own watcher
// open) writes files, then starts a fresh watch: only the writes made after
// that watch started may reach the new listener.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function worker(dir: string): void {
  const first = fs.watch(dir, { recursive: true }, () => {});
  setTimeout(() => {
    first.close();
    if (parentPort !== null) parentPort.postMessage("closed");
  }, 100);
  parentPort?.on("message", (message: unknown) => {
    if (message !== "rewatch") return;
    const names: string[] = [];
    let fresh = false;
    const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
      if (typeof filename !== "string") return;
      const name = filename.replaceAll("\\", "/");
      names.push(name);
      if (name === "fresh.txt") fresh = true;
    });
    setTimeout(() => {
      const stale = names.filter((name) => name.startsWith("stale-")).length;
      watcher.close();
      if (parentPort !== null) parentPort.postMessage({ stale, fresh });
    }, 400);
  });
}

if (!isMainThread) {
  worker((workerData as { dir: string }).dir);
} else {
  const root = fs.mkdtempSync(join(tmpdir(), "scr-rec-idle-"));
  const dir = join(root, "a");
  fs.mkdirSync(dir);
  // Keeps a stream on the directory alive while the worker has none, so the
  // writes below would have somewhere to accumulate.
  const watcher = fs.watch(dir, { recursive: true }, () => {});
  const child = new Worker(new URL(import.meta.url), { workerData: { dir } });
  child.on("message", (message: unknown) => {
    if (message === "closed") {
      for (let i = 1; i <= 5; i++) fs.writeFileSync(join(dir, `stale-${i}.txt`), String(i));
      setTimeout(() => child.postMessage("rewatch"), 150);
      setTimeout(() => fs.writeFileSync(join(dir, "fresh.txt"), "new"), 250);
      return;
    }
    const result = message as { stale: number; fresh: boolean };
    console.log("idle worker", result.stale === 0, result.fresh);
    watcher.close();
    child.terminate();
    fs.rmSync(root, { recursive: true, force: true });
    console.log("done");
  });
  child.on("error", (error: Error) => {
    console.error("worker error", error.message);
    process.exit(1);
  });
}
