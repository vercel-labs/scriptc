import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Several workers and the main thread build and drop objects filled in from
// an asserted empty literal at the same time. Each thread completes its own
// objects; none sees another thread's properties.
type Key = "alpha" | "beta" | "gamma";
type Row = Record<Key, number>;

function work(seed: number, rounds: number): number {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const row = {} as Row;
    row.gamma = seed + i;
    if (i % 2 === 0) row.alpha = 1;
    row.beta = 2;
    total += row.gamma + row.beta + ("alpha" in row ? row.alpha : 0) + Object.keys(row).length;
  }
  return total;
}

if (isMainThread) {
  const results: number[] = [];
  let pending = 4;
  for (let n = 0; n < 4; n++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { seed: n * 1000 } });
    worker.on("message", (total: number) => {
      results[n] = total;
      if (--pending === 0) console.log("workers", results.join(","));
    });
  }
  console.log("main", work(7, 3000));
} else {
  const data = workerData as { seed: number };
  parentPort!.postMessage(work(data.seed, 3000));
}
