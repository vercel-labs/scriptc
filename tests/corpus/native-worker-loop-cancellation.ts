import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  for (const kind of ["for", "do", "for-of"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), {workerData: kind});
      worker.once("message", () => { worker.terminate(); });
      worker.once("exit", (code: number) => { console.log(kind, code); resolve(); });
    });
  }
} else {
  parentPort!.postMessage("ready");
  try {
    if (workerData === "for") { for (;;) { continue; } }
    else if (workerData === "do") { do { continue; } while (true); }
    else {
      const growing = [1];
      for (const value of growing) growing.push(value);
    }
  } catch { console.log("unexpected catch"); }
  finally { console.log("unexpected finally"); }
}
