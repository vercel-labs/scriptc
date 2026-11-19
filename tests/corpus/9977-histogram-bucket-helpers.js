// histogram.linearBuckets(stepSize) and histogram.logBuckets(firstBucket,
// base): the Map Node builds from the recorded buckets (including the
// zero-count boundaries between them), on both histogram classes, and the
// argument validation errors.
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

const pairs = (map) => [...map].map(([key, value]) => `${key}:${value}`).join(",");
const record = (...values) => {
  const h = createHistogram();
  for (const value of values) h.record(value);
  return h;
};

console.log("linear", pairs(record(5, 15, 25).linearBuckets(10)));
console.log("linear-gap", pairs(record(1, 25).linearBuckets(10)));
console.log("linear-exact", pairs(record(5, 10, 15).linearBuckets(5)));
const nonzero = (map) => pairs(new Map([...map].filter(([, value]) => value > 0)));
const large = record(2049).linearBuckets(3);
console.log("linear-large", large.size, nonzero(large));
const largePair = record(2049, 2050).linearBuckets(3);
console.log("linear-large-pair", largePair.size, nonzero(largePair));
console.log("linear-empty", pairs(createHistogram().linearBuckets(10)));

console.log("log", pairs(record(5, 15, 25).logBuckets(1, 2)));
console.log("log-gap", pairs(record(64, 65).logBuckets(1, 2)));
console.log("log-tens", pairs(record(100).logBuckets(10, 10)));
console.log("log-three", pairs(record(1, 3, 9).logBuckets(1, 3)));
console.log("log-large", pairs(record(2049).logBuckets(1, 2)));
console.log("log-empty", pairs(createHistogram().logBuckets(1, 2)));

const interval = monitorEventLoopDelay();
console.log("interval", pairs(interval.linearBuckets(10)), pairs(interval.logBuckets(1, 2)));

const h = record(1);
for (const [label, run] of [
  ["step-string", () => h.linearBuckets("x")],
  ["step-zero", () => h.linearBuckets(0)],
  ["step-fraction", () => h.linearBuckets(1.5)],
  ["step-missing", () => h.linearBuckets()],
  ["first-zero", () => h.logBuckets(0, 2)],
  ["first-fraction", () => h.logBuckets(1.5, 2)],
  ["base-one", () => h.logBuckets(1, 1)],
  ["base-string", () => h.logBuckets(1, "y")],
  ["base-missing", () => h.logBuckets(1)],
]) {
  try {
    run();
    console.log("accepted", label);
  } catch (error) {
    console.log("invalid", label, error.name, error.code, error.message);
  }
}

// A sample below the histogram's lowest resolution sits in bucket zero; the
// map counts it at the first bucket.
const lowResolution = createHistogram({ lowest: 10 });
for (const value of [5, 5, 25]) lowResolution.record(value);
console.log("linear-low", pairs(lowResolution.linearBuckets(10)));
