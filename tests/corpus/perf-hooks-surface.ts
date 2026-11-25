// node:perf_hooks' documented surface, pinned entry by entry: the entry
// classes and their getters (own-key walks see none of them), mark and
// measure producing entries with their identity and JSON shape, the
// getEntries family's filtering and order, clearMarks/clearMeasures,
// nodeTiming's milestones and libuv metrics, the observer's delivery,
// takeRecords and supportedEntryTypes, eventLoopUtilization's shape, and
// monitorEventLoopDelay's histogram readings. Elapsed times vary run to
// run, so every number that does is compared as a sign or a range.
import {
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  eventLoopUtilization,
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";

function stable(value: unknown): string {
  return JSON.stringify(value).replace(/\d+\.\d+/g, "<n>");
}

console.log("classes", typeof PerformanceEntry, typeof PerformanceMark, typeof PerformanceMeasure);
console.log("supported", JSON.stringify(PerformanceObserver.supportedEntryTypes));
console.log("supported frozen", Object.isFrozen(PerformanceObserver.supportedEntryTypes));
console.log("supported identity", PerformanceObserver.supportedEntryTypes === PerformanceObserver.supportedEntryTypes);

const mark = performance.mark("listed", { startTime: 5, detail: { at: "start" } });
console.log("mark", mark.name, mark.entryType, mark.startTime, mark.duration, stable(mark.detail));
console.log("mark json", stable(mark.toJSON()));
console.log("mark instanceof", mark instanceof PerformanceMark, mark instanceof PerformanceEntry);
console.log("mark held", mark === performance.getEntriesByName("listed")[0]);

const measure = performance.measure("span", { start: 5, duration: 3, detail: "why" });
console.log("measure", measure.name, measure.entryType, measure.startTime, measure.duration, stable(measure.detail));
console.log("measure json", stable(measure.toJSON()));
console.log("measure instanceof", measure instanceof PerformanceMeasure);

performance.mark("later", { startTime: 9 });
console.log("by name", performance.getEntriesByName("later").map((e) => e.startTime).join(","));
console.log("by type marks", performance.getEntriesByType("mark").map((e) => e.name).join(","));
console.log("by type measures", performance.getEntriesByType("measure").map((e) => e.name).join(","));
console.log("all", performance.getEntries().map((e) => `${e.name}:${e.startTime}`).join(","));

const nodeTiming = performance.nodeTiming;
console.log("nodeTiming", nodeTiming.name, nodeTiming.entryType, nodeTiming.startTime);
console.log("nodeTiming json keys", Object.keys(nodeTiming.toJSON()).join(","));
console.log("nodeTiming milestones", [
  typeof nodeTiming.bootstrapComplete,
  typeof nodeTiming.environment,
  typeof nodeTiming.loopStart,
  typeof nodeTiming.loopExit,
  nodeTiming.nodeStart <= nodeTiming.v8Start,
  nodeTiming.v8Start <= nodeTiming.bootstrapComplete,
].join(","));
console.log("uv metrics", Object.keys(nodeTiming.uvMetricsInfo).join(","), nodeTiming.uvMetricsInfo.loopCount >= 0);

const utilization = performance.eventLoopUtilization();
console.log("eld keys", Object.keys(utilization).join(","), utilization.active >= 0, utilization.idle >= 0, utilization.utilization >= 0 && utilization.utilization <= 1);
const combined = eventLoopUtilization(utilization);
console.log("eld module twin", combined.active >= 0, combined.idle >= 0);

const seen: string[] = [];
const observer = new PerformanceObserver((list, self) => {
  seen.push(list.getEntries().map((e) => `${e.name}:${e.entryType}`).join(","));
  seen.push(self === observer ? "self" : "other");
});
observer.observe({ entryTypes: ["mark"], buffered: false });
performance.mark("observed", { startTime: 20 });
performance.measure("not-observed", { start: 20, duration: 1 });
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("observed", seen.join("|"));
console.log("takeRecords", observer.takeRecords().length);
observer.disconnect();
performance.mark("after-disconnect", { startTime: 30 });
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("after disconnect", seen.join("|"));

const histogram = monitorEventLoopDelay({ resolution: 5 });
histogram.enable();
await new Promise((resolve) => setTimeout(resolve, 20));
histogram.disable();
console.log("histogram", histogram.count >= 0, histogram.exceeds >= 0, histogram.min >= 0, histogram.max >= 0);
console.log("histogram mean", typeof histogram.mean, typeof histogram.stddev, histogram.percentile(50) >= 0);
histogram.reset();
console.log("histogram reset", histogram.count, histogram.exceeds);
histogram.enable();
histogram.enable();
histogram.disable();
histogram.disable();

performance.clearMarks();
performance.clearMeasures();
console.log("cleared", performance.getEntries().length);
