// Two Histogram paths: a RecordableHistogram records bigints beyond
// Number.MAX_SAFE_INTEGER, so percentileBigInt answers the exact bucket
// value (not the double-rounding one), and a Histogram-typed parameter
// holding a monitorEventLoopDelay IntervalHistogram reads the event-loop
// histogram's own counters, timers, percentile and reset.
import {
  createHistogram,
  monitorEventLoopDelay,
  type Histogram,
} from "node:perf_hooks";

const big = createHistogram({ lowest: 1n, highest: 2n ** 62n });
big.record(2n ** 60n);
big.record(2n ** 60n + 12345n);
console.log("big", big.percentileBigInt(100), big.maxBigInt, big.percentileBigInt(50), big.minBigInt);
console.log("big double", big.percentile(100), Number(big.maxBigInt));

const eld = monitorEventLoopDelay({ resolution: 5 });
eld.enable();
await new Promise((resolve) => setTimeout(resolve, 60));
eld.disable();

const asHistogram: Histogram = eld;
console.log(
  "upcast",
  asHistogram.count === eld.count,
  asHistogram.count > 0,
  asHistogram.min === eld.min,
  asHistogram.max === eld.max,
  asHistogram.mean === eld.mean,
  asHistogram.stddev === eld.stddev,
  asHistogram.percentile(50) === eld.percentile(50),
  Number(asHistogram.percentileBigInt(50)) === eld.percentile(50),
  asHistogram.exceeds === eld.exceeds,
);
console.log(
  "upcast big",
  Number(asHistogram.countBigInt) === asHistogram.count,
  Number(asHistogram.minBigInt) === asHistogram.min,
  Number(asHistogram.maxBigInt) === asHistogram.max,
  asHistogram.exceedsBigInt === 0n,
);
console.log("upcast countAt", asHistogram.countAt(asHistogram.min) > 0, asHistogram.cdf(1e15) > 0);
asHistogram.reset();
console.log("upcast reset", asHistogram.count, eld.count, asHistogram.percentile(50), eld.percentile(50));
console.log(
  "upcast reset big",
  asHistogram.countBigInt,
  asHistogram.minBigInt === 9223372036854775807n,
  Number(asHistogram.minBigInt) === asHistogram.min,
);
