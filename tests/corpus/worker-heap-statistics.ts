// worker.getHeapStatistics() answers the worker thread's heap figures in
// v8.getHeapStatistics()'s field names and order, and rejects once the
// worker has stopped.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", async () => {
    const stats = await worker.getHeapStatistics();
    console.log("fields", Object.keys(stats).join(","));
    console.log("sane", stats.total_heap_size >= stats.used_heap_size, stats.heap_size_limit > 0);
    worker.postMessage("done");
  });
  worker.on("exit", async () => {
    try {
      await worker.getHeapStatistics();
      console.log("after exit resolved");
    } catch (error: any) {
      console.log("after exit", error.code);
    }
  });
} else {
  parentPort!.postMessage("ready");
  parentPort!.once("message", () => {});
}
