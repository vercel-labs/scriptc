// perf_hooks createHistogram's EWMA readings and the SLO burn rate. When the
// options set a halfLife, each recorded value smooths the mean and variance
// with alpha = 1 - 2^(-1/halfLife); a threshold adds the smoothed error rate
// the burn rate divides by the SLO's error budget. Without halfLife every
// EWMA reading is 0, and a reset clears the state.
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";

function round(value: number): number {
  return Number(value.toFixed(6));
}

const off = createHistogram();
off.record(10);
console.log("off", off.ewmaMean, off.ewmaStddev, off.ewmaErrorRate, off.burnRate(0.999));

const plain = createHistogram({ halfLife: 10 });
for (const value of [50, 150, 200, 25]) plain.record(value);
console.log(
  "ewma",
  round(plain.ewmaMean),
  round(plain.ewmaStddev),
  plain.ewmaErrorRate,
  plain.burnRate(0.9),
);

const slo = createHistogram({ halfLife: 10, threshold: 100 });
for (const value of [50, 150, 200]) slo.record(value);
console.log(
  "slo",
  round(slo.ewmaMean),
  round(slo.ewmaStddev),
  round(slo.ewmaErrorRate),
  round(slo.burnRate(0.999)),
  round(slo.burnRate(0.5)),
);

// A threshold without a halfLife leaves both EWMAs off.
const thresholdOnly = createHistogram({ threshold: 10 });
thresholdOnly.record(100);
console.log("threshold only", thresholdOnly.ewmaErrorRate, thresholdOnly.burnRate(0.99));

// reset clears the EWMA state as well as the buckets.
slo.reset();
console.log("reset", slo.count, slo.ewmaMean, slo.ewmaStddev, slo.ewmaErrorRate);

// recordCorrected smooths the recorded value once, not each backfilled
// intermediate sample.
const corrected = createHistogram({ halfLife: 2 });
corrected.recordCorrected(1000, 100);
console.log(
  "corrected",
  corrected.count,
  round(corrected.ewmaMean),
  round(corrected.ewmaStddev),
);

// The readings answer through a checked-dynamic read too.
const dynamic: any = slo;
slo.record(70);
slo.record(130);
console.log("dyn", round(dynamic.ewmaMean), round(dynamic.ewmaStddev), dynamic.ewmaErrorRate);

// burnRate validates its target: Node's ERR_OUT_OF_RANGE for a number outside
// (0, 1), its ERR_INVALID_ARG_TYPE for anything else.
const badTargets: number[] = [0, 1, -0.5, 1.5, NaN, Infinity];
for (const target of badTargets) {
  try {
    plain.burnRate(target);
    console.log("burn accepted", target);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("burn error", e.name, e.code, e.message);
  }
}
try {
  plain.burnRate("0.99" as any);
  console.log("burn accepted string");
} catch (error) {
  const e = error as { name: string; code: string; message: string };
  console.log("burn string error", e.name, e.code, e.message);
}

// The options validate halfLife and threshold as non-negative numbers.
const badOptions: [string, number | string][] = [
  ["halfLife", -1],
  ["threshold", -1],
  ["halfLife", "2"],
];
for (const [key, value] of badOptions) {
  try {
    const bad = createHistogram({ [key]: value } as any);
    bad.record(1);
    console.log("options accepted", key, value);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("options error", e.name, e.code, e.message);
  }
}

// Bucket maps: linear and logarithmic intervals, a multi-percentile pass and
// the BigInt percentiles Map. Node's hdr iterators emit each reporting level
// with the count it collected, including the empty levels.
const buckets = createHistogram();
for (const value of [1, 2, 3, 1000]) buckets.record(value);
console.log("linear", JSON.stringify([...buckets.linearBuckets(100)]));
console.log("linear 250", JSON.stringify([...buckets.linearBuckets(250)]));
console.log("log", JSON.stringify([...buckets.logBuckets(1, 2)]));
console.log("log 3", JSON.stringify([...buckets.logBuckets(2, 3)]));
console.log("at", JSON.stringify([...buckets.percentilesAt([90, 50, 99.9])]));
console.log("at 100", JSON.stringify([...buckets.percentilesAt([100])]));
const bigPercentiles = buckets.percentilesBigInt as unknown as Map<number, bigint>;
console.log("big", JSON.stringify([...bigPercentiles].map(([k, v]) => [k, String(v)])));

const emptyBuckets = createHistogram();
console.log("empty at", JSON.stringify([...emptyBuckets.percentilesAt([50, 90])]));
console.log("empty linear", JSON.stringify([...emptyBuckets.linearBuckets(5)]));
console.log("empty log", JSON.stringify([...emptyBuckets.logBuckets(1, 2)]));
const emptyBig = emptyBuckets.percentilesBigInt as unknown as Map<number, bigint>;
console.log("empty big", JSON.stringify([...emptyBig].map(([k, v]) => [k, String(v)])));

// A layout whose bucket width is larger than the step: the hdr iterator keys
// the map by each bucket's nominal (quantized) value, and reporting levels
// that fall in one bucket share that key, so the map is smaller than the
// number of levels crossed.
const quantized = createHistogram({ lowest: 1000, highest: 1_000_000, figures: 1 });
for (const value of [1000, 1500, 2000, 5000, 20000, 100000]) quantized.record(value);
const quantizedLinear = [...quantized.linearBuckets(3000)];
console.log("quantized linear", JSON.stringify(quantizedLinear));
console.log("quantized log", JSON.stringify([...quantized.logBuckets(1500, 3)]));
const quantizedWide = [...quantized.linearBuckets(100)];
console.log(
  "quantized wide",
  quantizedWide.length,
  JSON.stringify(quantizedWide.slice(0, 3)),
  JSON.stringify(quantizedWide.slice(-2)),
);

// Validation for every bucket form.
for (const step of [0, -1, 1.5]) {
  try {
    buckets.linearBuckets(step);
    console.log("linear accepted", step);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("linear error", e.name, e.code, e.message);
  }
}
for (const base of [1, 0, -2]) {
  try {
    buckets.logBuckets(1, base);
    console.log("log accepted", base);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("log error", e.name, e.code, e.message);
  }
}
for (const list of [[0], [101], [50, NaN]]) {
  try {
    buckets.percentilesAt(list);
    console.log("at accepted", JSON.stringify(list));
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("at error", e.name, e.code, e.message);
  }
}

// monitorEventLoopDelay's IntervalHistogram carries the same EWMA members;
// with no halfLife option they read 0 and burnRate follows from that.
const interval = monitorEventLoopDelay({ resolution: 20 });
interval.enable();
interval.disable();
interval.reset();
console.log(
  "eld",
  interval.ewmaMean,
  interval.ewmaStddev,
  interval.ewmaErrorRate,
  interval.burnRate(0.999),
);

// One large observation with unit steps walks every reporting level, but HDR
// quantization shares bucket keys: the Map has one entry per bucket, and the
// staging stays bounded by distinct keys rather than the level count.
const large = createHistogram();
large.record(200000);
const unit = [...large.linearBuckets(1)];
console.log("unit", unit.length, JSON.stringify(unit.slice(0, 3)), JSON.stringify(unit.slice(-2)));
const unitLog = [...large.logBuckets(1, 2)];
console.log("unit log", unitLog.length, JSON.stringify(unitLog.slice(0, 3)), JSON.stringify(unitLog.slice(-2)));
