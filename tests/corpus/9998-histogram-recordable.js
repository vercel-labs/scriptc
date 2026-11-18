// createHistogram's RecordableHistogram members a JavaScript source can
// reach: recordDelta, recordCorrected (coordinated-omission backfill),
// subtract, countAt, cdf and ccdf. Timings vary, so the delta's own value
// is checked as a bound and the call's effect as a count.
import { createHistogram } from "node:perf_hooks";

const h = createHistogram();
h.record(100);
h.record(200);
const before = h.count;
h.recordDelta();
console.log("delta", h.count === before || h.count === before + 1, h.min >= 1);

h.recordCorrected(1000, 100);
console.log("corrected", h.count, h.countAt(900), h.countAt(1000), h.percentile(100));

const other = createHistogram();
other.record(100);
other.record(300);
h.add(other);
console.log("added", h.count, h.countAt(300), h.countAt(100));
h.subtract(other);
console.log("subtracted", h.count, h.countAt(300), h.countAt(100));

console.log("cdf", h.cdf(200) > 0 && h.cdf(200) < 1, h.cdf(100000) === 1, h.ccdf(100000) === 0);
h.reset();
console.log("reset", h.count, h.countAt(100), h.percentile(50));
