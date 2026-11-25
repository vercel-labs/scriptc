// A histogram read through a checked-dynamic spelling answers the same
// readings as the typed property, the `in` probe finds them, and an
// interval histogram keeps its readings after its sampling timer stops.
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

const histogram = createHistogram();
histogram.record(3);
histogram.record(5);

const dynamic = histogram;
console.log(
  "dyn",
  dynamic.count,
  dynamic.min,
  dynamic.max,
  dynamic.mean,
  dynamic.stddev,
  dynamic.exceeds,
  dynamic["count"],
  dynamic["mean"],
);
console.log(
  "big",
  String(dynamic.countBigInt),
  String(dynamic.minBigInt),
  String(dynamic.maxBigInt),
  String(dynamic.exceedsBigInt),
);
console.log("in", "count" in dynamic, "mean" in dynamic, "nope" in dynamic);

const interval = monitorEventLoopDelay({ resolution: 10 });
interval.enable();
interval.disable();
interval.reset();
console.log(
  "eld",
  interval.count,
  interval.min,
  interval.max,
  typeof interval.mean,
  typeof dynamic.mean,
  "count" in interval,
);
