// perf_hooks Histogram.percentilesAt reads each requested percentile from a
// dynamic array. The runtime's element access returns an owned reference, so
// every read must be released: the sanitized lane runs this program with
// LeakSanitizer and the runtime's reference-count audit, which report a leak
// for each element the accessor hands out and nobody releases.
//
// One array with fractional percentiles exercises the successful path, and
// three invalid arrays exercise the throws after earlier elements were read.
import { createHistogram } from "node:perf_hooks";

const histogram = createHistogram();
for (let i = 1; i <= 1000; i++) histogram.record(i);

const percentiles = [50, 90.5, 99.9, 100];
let sum = 0;
for (let i = 0; i < 20000; i++) {
  for (const [, value] of histogram.percentilesAt(percentiles)) sum += value;
}

const invalid: number[][] = [[0], [50, 101], [50, NaN]];
for (let i = 0; i < 20000; i++) {
  for (const list of invalid) {
    try {
      histogram.percentilesAt(list);
    } catch {
      // The validation throw is the path under test.
    }
  }
}

console.log("sum", sum);
