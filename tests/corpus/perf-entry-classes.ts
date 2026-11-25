// The perf_hooks entry classes Node 24 also defines as globals: new
// PerformanceMark(name, options) builds an entry outside the timeline, and
// every entry answers the class chain PerformanceMark/PerformanceMeasure ->
// PerformanceEntry.
import {
  performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
} from "node:perf_hooks";

console.log(typeof PerformanceMark, typeof PerformanceEntry, typeof PerformanceMeasure);

const mark = new PerformanceMark("alpha", { startTime: 3 });
console.log(mark.name, mark.entryType, mark.startTime, mark.duration, mark.detail);
const detailed = new PerformanceMark("beta", { startTime: 12.5, detail: { k: [1, 2] } });
console.log(detailed.startTime, JSON.stringify(detailed.detail));
console.log(String(mark), JSON.stringify(detailed));

console.log(
  mark instanceof PerformanceMark,
  mark instanceof PerformanceEntry,
  mark instanceof PerformanceMeasure,
);
const measured = performance.measure("span", { start: 1, end: 3 });
console.log(
  measured instanceof PerformanceMeasure,
  measured instanceof PerformanceEntry,
  measured instanceof PerformanceMark,
);

// A checked-dynamic entry takes the class chain too.
const dynamicMark: any = performance.mark("gamma", { startTime: 2 });
console.log(
  dynamicMark instanceof PerformanceMark,
  dynamicMark instanceof PerformanceEntry,
  dynamicMark instanceof PerformanceMeasure,
);
const dynamicMeasure: any = measured;
console.log(dynamicMeasure instanceof PerformanceMeasure, dynamicMeasure instanceof PerformanceEntry);

// The constructor's mark is not in the timeline.
console.log(performance.getEntriesByName("alpha").length);
