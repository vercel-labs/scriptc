// monitorEventLoopDelay's IntervalHistogram: the resolution option's
// validation, the empty histogram's readings, enable/disable idempotence,
// percentile range validation, the statistics after a sampling window, and
// reset. Sample counts depend on timer scheduling, so the program pins
// their signs rather than their values.
import { monitorEventLoopDelay } from "node:perf_hooks";

function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "no throw");
  } catch (error) {
    const e = error as Error & { code?: string };
    console.log(label, e.code, e.message);
  }
}

attempt("resolution 0", () => monitorEventLoopDelay({ resolution: 0 }));
attempt("resolution 1.5", () => monitorEventLoopDelay({ resolution: 1.5 }));
attempt("resolution -1", () => monitorEventLoopDelay({ resolution: -1 }));
attempt("resolution NaN", () => monitorEventLoopDelay({ resolution: Number.NaN }));

const histogram = monitorEventLoopDelay();
console.log("empty", histogram.count, histogram.exceeds, histogram.percentile(50), histogram.min, histogram.max);
console.log("stats types", typeof histogram.mean, typeof histogram.stddev);
console.log("enable", histogram.enable(), histogram.enable());
console.log("disable", histogram.disable(), histogram.disable());
attempt("percentile 0", () => histogram.percentile(0));
attempt("percentile 101", () => histogram.percentile(101));
attempt("percentile NaN", () => histogram.percentile(Number.NaN));
console.log("percentile 100", typeof histogram.percentile(100));

// Node records nothing on the first tick after enable and this timer wheel
// can place a boundary tick differently from libuv's, so the sampling
// window waits for a recorded sample instead of assuming how many ticks a
// fixed delay holds. The assertions below then read a histogram that has
// data on both sides whatever the runner's load.
histogram.enable();
for (let turn = 0; turn < 100 && histogram.count === 0; turn++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
histogram.disable();
console.log("sampled", histogram.count > 0, histogram.exceeds >= 0, histogram.min > 0, histogram.max >= histogram.min);
console.log("sampled stats", typeof histogram.mean, typeof histogram.stddev, histogram.percentile(50) > 0, histogram.percentile(99.9) >= histogram.percentile(50));
histogram.reset();
console.log("reset", histogram.count, histogram.exceeds, histogram.percentile(50));

const fine = monitorEventLoopDelay({ resolution: 1 });
fine.enable();
for (let turn = 0; turn < 100 && fine.count === 0; turn++) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
fine.disable();
console.log("fine sampled", fine.count > 0);
