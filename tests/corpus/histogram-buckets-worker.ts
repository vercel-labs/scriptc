// A worker that builds a histogram bucket map frees its thread-local view as
// it exits; a second worker still answers its own map, so one thread's build
// does not settle anything for the next.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { createHistogram } from "node:perf_hooks";

if (isMainThread) {
  for (const round of [1, 2]) {
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url));
      worker.on("message", (message) => console.log("worker", round, message));
      worker.on("error", reject);
      worker.on("exit", (code) => {
        console.log("exit", round, code);
        resolve();
      });
    });
  }
} else {
  const histogram = createHistogram();
  for (const value of [1, 5, 25]) histogram.record(value);
  const pairs = [...histogram.linearBuckets(10)];
  parentPort?.postMessage(`${pairs.length}:${pairs.reduce((total, [, count]) => total + count, 0)}`);
}
