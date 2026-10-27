// Event-loop monitoring under @types/node: monitorEventLoopDelay's histogram,
// eventLoopUtilization deltas, and an unref'd interval typed NodeJS.Timeout.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import * as perfHooks from "node:perf_hooks";
import { monitorEventLoopDelay as eld } from "node:perf_hooks";

const histogram = monitorEventLoopDelay({ resolution: 10 });
console.log("enable", histogram.enable(), histogram.enable());
const first = performance.eventLoopUtilization();
console.log("before loop", first.idle, first.active, first.utilization);

let last = performance.eventLoopUtilization();
let ticks = 0;
// The unref'd interval keeps nothing alive; this timer holds the loop open
// until the third sample.
const keepAlive = setTimeout(() => console.log("never"), 10_000);
const interval = setInterval(() => {
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
  console.log(
    "tick",
    ticks,
    delta.utilization >= 0 && delta.utilization <= 1,
    delta.idle >= 0,
    p50 > 0,
    p99 >= p50,
    histogram.max >= p99,
    histogram.min <= p50,
    histogram.count > 0,
  );
  histogram.reset();
  console.log(
    "after reset",
    histogram.count,
    histogram.max,
    histogram.min,
    Number.isNaN(histogram.mean),
    histogram.percentile(50),
  );
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

// Other import spellings, and Node's resolution validation.
const aliased = eld();
const namespaced = perfHooks.monitorEventLoopDelay({ resolution: 20 });
console.log("spellings", aliased.enable(), namespaced.enable(), aliased.disable(), namespaced.disable());
for (const resolution of [0, -0, -1, 1.5, NaN, Infinity, 1e16, 1]) {
  try {
    eld({ resolution });
    console.log("created", resolution);
  } catch (e) {
    console.log((e as Error).name, (e as { code?: string }).code, (e as Error).message);
  }
}
// An undefined resolution takes Node's default.
function withResolution(resolution?: number): boolean {
  const h = monitorEventLoopDelay({ resolution });
  return h.enable() && h.disable();
}
console.log("defaults", withResolution(), withResolution(20), eld({ resolution: undefined }).enable());
