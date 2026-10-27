// 100,000 caught AssertionErrors read through a cast, on the main thread
// or (with the "worker" argument) in a worker; prints the resident-set
// growth in MiB after a warm-up round.
import * as assert from "node:assert";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

function round(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    try {
      assert.strictEqual(i, -1);
    } catch (e) {
      const err = e as { code?: string; operator?: string };
      total += (err.code ?? "").length + (err.operator ?? "").length;
    }
  }
  return total;
}

function measure(): number {
  round(20000);
  const before = process.memoryUsage().rss;
  for (let r = 0; r < 5; r++) round(20000);
  return Math.round((process.memoryUsage().rss - before) / 1048576);
}

if (!isMainThread) {
  parentPort?.postMessage(measure());
} else if (process.argv[2] === "worker") {
  const worker = new Worker(new URL(import.meta.url));
  worker.once("message", (growth: number) => console.log(growth));
} else {
  console.log(measure());
}
