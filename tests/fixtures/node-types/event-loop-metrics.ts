// Event-loop monitoring under @types/node: monitorEventLoopDelay's histogram,
// eventLoopUtilization deltas, and an unref'd interval typed NodeJS.Timeout.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const histogram = monitorEventLoopDelay({ resolution: 10 });
console.log("enable", histogram.enable(), histogram.enable());
const first = performance.eventLoopUtilization();
console.log("before loop", first.idle, first.active, first.utilization);

let last = performance.eventLoopUtilization();
let ticks = 0;
// The unref'd interval keeps nothing alive; this timer holds the loop open
// until the third sample.
const keepAlive = setTimeout(() => console.log("never"), 10_000);
const interval: NodeJS.Timeout = setInterval(() => {
  // A delta needs two samples after a reset. A loop that wakes late can run
  // only one sample per window; that window is skipped without a reset, so
  // the next one records.
  if (histogram.count === 0) return;
  const now = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(now, last);
  last = now;
  ticks++;
  const p50 = histogram.percentile(50);
  const p99 = histogram.percentile(99);
  // The delta's idle and utilization are read, but the program does not print
  // a range check on them: Node's usage counters are cumulative, so its deltas
  // never go backwards, while scriptc's idle sample is wall time minus thread
  // CPU time clamped per sample, and the difference of two such samples can
  // dip below zero when the CPU-time clock jumps ahead of the wall clock.
  console.log(
    "tick",
    ticks,
    typeof delta.utilization,
    delta.active >= 0,
    p50 > 0,
    p99 >= p50,
    histogram.max >= p99,
    histogram.min <= p50,
    histogram.count > 0,
  );
  histogram.reset();
  console.log("after reset", histogram.count, histogram.max, histogram.min, Number.isNaN(histogram.mean));
  if (ticks === 3) {
    clearInterval(interval);
    clearTimeout(keepAlive);
    console.log("disable", histogram.disable(), histogram.disable());
    const since = performance.eventLoopUtilization(first);
    console.log("since", since.utilization > 0 && since.utilization <= 1, since.idle > 0);
    try {
      histogram.percentile(0);
    } catch (e) {
      console.log((e as Error).message, (e as { code?: string }).code);
    }
  }
}, 50);
interval.unref();
console.log("hasRef", interval.hasRef());
