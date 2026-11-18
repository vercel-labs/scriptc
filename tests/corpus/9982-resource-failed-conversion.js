// A resource entry whose metadata cannot convert (a Symbol-valued bodyInfo
// field) is still recorded, and the timeline stays readable: the failed
// field takes its default instead of leaving a half-built entry that made
// later reads abort the process.
import { performance } from "node:perf_hooks";

performance.setResourceTimingBufferSize(10);
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
performance.markResourceTiming(
  timing(1),
  "https://example.test/ok",
  "fetch",
  undefined,
  "",
  { contentType: Symbol("content-type") },
  200,
);
const entries = performance.getEntriesByType("resource");
console.log("entries", entries.length, entries[0].name, entries[0].startTime, entries[0].responseStatus);
console.log("all", performance.getEntries().length);
