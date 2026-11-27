// linearBuckets walks reporting levels and collapses each histogram bucket
// to one key; the map must match Node's for small and large steps, including
// steps smaller than a bucket (many levels, one key).
import { createHistogram } from "node:perf_hooks";

const h = createHistogram({ lowest: 1, highest: 1000000, figures: 2 });
for (const value of [1, 10, 10, 500, 65536, 999999, 1000000]) h.record(value);

for (const step of [1, 3, 7, 1000, 1000000]) {
  const entries = [...h.linearBuckets(step)];
  let sum = 0;
  for (const [, count] of entries) sum += count;
  const first = entries[0];
  const last = entries[entries.length - 1];
  console.log(step, "keys", entries.length, "sum", sum, "first", `${first[0]}:${first[1]}`, "last",
              `${last[0]}:${last[1]}`);
}
