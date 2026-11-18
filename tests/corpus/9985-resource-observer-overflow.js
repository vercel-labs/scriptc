// A resource entry the timeline buffer drops is still delivered to live
// observers, and a typed read of the observer's list answers its fields.
import { performance, PerformanceObserver } from "node:perf_hooks";

const timing = (start) => ({
  startTime: start,
  endTime: start + 1,
  domainLookupStart: start,
  domainLookupEnd: start,
  connectStart: start,
  connectEnd: start,
  requestStart: start,
  responseStart: start,
  responseEnd: start + 1,
  secureConnectionStart: 0,
  fetchStart: start,
  redirectStart: 0,
  redirectEnd: 0,
});

performance.setResourceTimingBufferSize(1);
const observed = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    observed.push(`${entry.name}:${entry.responseStatus}:${entry.entryType}`);
  }
});
observer.observe({ type: "resource" });
performance.markResourceTiming(timing(1), "https://example.test/one", "fetch", undefined, "", undefined, 200);
performance.markResourceTiming(timing(3), "https://example.test/two", "fetch", undefined, "", undefined, 201);
console.log(
  "timeline",
  performance.getEntriesByType("resource").map((entry) => entry.name).join(","),
);
await new Promise((resolve) => setTimeout(resolve, 10));
observer.disconnect();
console.log("observed", observed.join(","));
