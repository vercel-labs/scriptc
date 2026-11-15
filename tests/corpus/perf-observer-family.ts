// PerformanceObserver: observe({ entryTypes }), takeRecords drains the
// buffered entries synchronously, disconnect stops delivery, and the
// callback receives a PerformanceObserverEntryList. The callback runs from
// an immediate, so at the end of the synchronous program it has not run.
import {
  performance,
  PerformanceMark,
  PerformanceObserver,
  PerformanceObserverEntryList,
} from "node:perf_hooks";

const delivered: string[] = [];
const observer = new PerformanceObserver((list: PerformanceObserverEntryList) => {
  for (const entry of list.getEntries()) delivered.push(`${entry.entryType}:${entry.name}`);
});
observer.observe({ entryTypes: ["mark"] });

performance.mark("first", { startTime: 1 });
performance.mark("second", { startTime: 2 });
const taken = observer.takeRecords();
console.log(taken.length, taken.map((entry) => entry.name));
console.log(taken[0] instanceof PerformanceMark, taken[0]?.duration);
console.log(Array.isArray(taken));
observer.disconnect();
performance.mark("after", { startTime: 3 });
console.log(observer.takeRecords().length);

// The same observer follows measures now, and each entry is a measure.
observer.observe({ entryTypes: ["measure"] });
performance.measure("span", { start: 1, end: 2 });
const measures = observer.takeRecords();
console.log(measures.length, measures[0]?.entryType, measures[0]?.duration);
observer.disconnect();

// observe({ type }) is the single-type form.
const typed: string[] = [];
const single = new PerformanceObserver((list: PerformanceObserverEntryList) => {
  for (const entry of list.getEntries()) typed.push(entry.name);
});
single.observe({ type: "mark" });
console.log(single.takeRecords().length);
single.disconnect();

console.log(
  observer instanceof PerformanceObserver,
  observer instanceof PerformanceMark,
  delivered.length,
);
