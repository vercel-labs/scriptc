// Errors that cross into checked-dynamic code (a cast of a caught error)
// in a retry loop, on the main thread and in a worker at the same time:
// every crossing reads the properties of its own error.
import * as assert from "node:assert";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

function round(n: number, offset: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    try {
      assert.strictEqual(i + offset, -1);
    } catch (e) {
      const err = e as { code?: string; operator?: string; actual?: number };
      total += (err.code ?? "").length + (err.operator ?? "").length + (err.actual === i + offset ? 1 : 0);
    }
  }
  return total;
}

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const fromWorker = new Promise<number>((resolve) => worker.once("message", resolve));
  let sum = 0;
  for (let r = 0; r < 5; r++) sum += round(5000, r);
  console.log("main", sum);
  console.log("worker", await fromWorker);
} else {
  let sum = 0;
  for (let r = 0; r < 5; r++) sum += round(5000, 100 + r);
  parentPort?.postMessage(sum);
}
