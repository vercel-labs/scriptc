// perf_hooks createHistogram: the RecordableHistogram readings and the
// HdrHistogram bucket semantics Node answers (count/min/max/mean/stddev,
// exceeds, the BigInt readings, percentile, the percentiles Map, record,
// add and reset), over the default options and an explicit bucket layout.
import { createHistogram } from "node:perf_hooks";

function show(label: string, values: (number | bigint | string)[]): void {
  let text = "";
  for (let i = 0; i < values.length; i++) {
    if (i > 0) text += ",";
    text += String(values[i]);
  }
  console.log(label, text);
}

const empty = createHistogram();
show("empty", [empty.count, empty.min, empty.max, empty.mean, empty.stddev, empty.exceeds]);
// This @types/node predates Node 24.22's shape moments; the runtime has them.
show("empty moments", [(empty as any).skewness, (empty as any).kurtosis]);
show("empty big", [empty.countBigInt, empty.minBigInt, empty.maxBigInt, empty.exceedsBigInt]);
console.log("empty percentiles", JSON.stringify([...empty.percentiles]));

const h = createHistogram();
for (const value of [5, 10, 10, 100, 1000, 7]) h.record(value);
show("recorded", [h.count, h.min, h.max, h.mean, h.stddev, h.exceeds]);
show("recorded moments", [
  Number(h.mean.toFixed(6)),
  Number(h.stddev.toFixed(6)),
  Number((h as any).skewness.toFixed(6)),
  Number((h as any).kurtosis.toFixed(6)),
]);
show("recorded big", [h.countBigInt, h.minBigInt, h.maxBigInt, h.exceedsBigInt]);
show("percentile", [h.percentile(1), h.percentile(50), h.percentile(90), h.percentile(100)]);
show("percentile big", [h.percentileBigInt(50), h.percentileBigInt(100)]);
console.log("percentiles", JSON.stringify([...h.percentiles]));

// Node answers kurtosis only from four samples: two and three read 0 while
// skewness reports its own moment.
const few = createHistogram();
few.record(5);
few.record(9);
few.record(20);
show("three-sample moments", [(few as any).skewness.toFixed(6), (few as any).kurtosis]);
few.record(40);
show("four-sample moments", [(few as any).skewness.toFixed(6), (few as any).kurtosis.toFixed(6)]);

// A bigint record takes the exact integer form.
h.record(2n ** 40n);
show("after bigint record", [h.count, h.max, h.percentile(100)]);
console.log("percentiles big", JSON.stringify([...h.percentiles].map(([k, v]) => [k, v])));

// add merges another histogram's recorded values.
const other = createHistogram();
other.record(5);
other.record(10);
other.record(50);
h.add(other);
show("after add", [h.count, h.min, h.max, h.percentile(100)]);

// reset clears every reading.
h.reset();
show("after reset", [h.count, h.min, h.max, h.mean, h.stddev, h.exceeds]);
show("after reset moments", [(h as any).skewness, (h as any).kurtosis]);
show("after reset big", [h.countBigInt, h.minBigInt, h.maxBigInt]);

// An explicit bucket layout quantizes values, as Node's hdr histogram does.
const custom = createHistogram({ lowest: 10, highest: 100400, figures: 2 });
for (let i = 0; i < 100; i++) custom.record(1000 + i * 10);
show("custom", [custom.count, custom.min, custom.max, custom.mean, custom.stddev]);
show("custom moments", [
  Number(custom.mean.toFixed(4)),
  Number((custom as any).skewness.toFixed(6)),
  Number((custom as any).kurtosis.toFixed(6)),
]);
show("custom percentiles", [
  custom.percentile(50),
  custom.percentile(75),
  custom.percentile(90),
  custom.percentile(100),
]);
console.log("custom map", JSON.stringify([...custom.percentiles]));

// The bigint options form.
const bigOptions = createHistogram({ lowest: 1n, highest: 4000n, figures: 1 });
bigOptions.record(1);
bigOptions.record(1000);
bigOptions.record(4000);
show("big options", [bigOptions.count, bigOptions.min, bigOptions.max, bigOptions.percentile(50)]);

// recordCorrected backfills the missing intervals; subtract removes another
// histogram's counts (clamped at zero); countAt and the CDF read buckets.
const corrected = createHistogram();
corrected.recordCorrected(1000, 100);
console.log("corrected", corrected.count, corrected.countAt(900), corrected.countAt(1000));
console.log("corrected cdf", corrected.cdf(900), corrected.ccdf(900), corrected.cdf(10000));
const removed = createHistogram();
removed.record(1000);
removed.record(1100);
corrected.subtract(removed);
console.log("subtracted", corrected.count, corrected.countAt(1000), corrected.countAt(900));

// Validation: Node's catchable RangeErrors, code and message.
const bad: (number | bigint)[] = [0, -3, 1.5, NaN, Infinity];
for (const value of bad) {
  try {
    h.record(value);
    console.log("record accepted", value);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("record error", e.name, e.code, e.message);
  }
}
for (const value of [0, -1, 101, NaN]) {
  try {
    h.percentile(value);
    console.log("percentile accepted", value);
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("percentile error", e.name, e.code, e.message);
  }
}
const badOptions: unknown[] = [
  { lowest: 0 },
  { lowest: 10, highest: 5 },
  { figures: 0 },
  { figures: 6 },
  { figures: 1.5 },
];
for (const options of badOptions) {
  try {
    createHistogram(options as { figures?: number });
    console.log("options accepted");
  } catch (error) {
    const e = error as { name: string; code: string; message: string };
    console.log("options error", e.name, e.code, e.message);
  }
}
