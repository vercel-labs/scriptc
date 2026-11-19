// A histogram is a refcounted runtime object: a short-lived one is freed
// with its last reference instead of staying in a thread table until exit.
// Twenty thousand default-layout histograms would keep roughly 7 GB of
// bucket arrays alive if they leaked, so this program completes only when
// the buckets are released as each local goes away.
import { createHistogram } from "node:perf_hooks";

function one(value: number): number {
  const h = createHistogram();
  h.record(value);
  return h.max;
}

let sum = 0;
for (let i = 0; i < 20000; i++) sum += one(1 + (i % 500));
console.log("sum", sum);

const last = createHistogram();
last.record(42);
last.record(7);
console.log("last", last.count, last.min, last.max, last.percentile(50));
