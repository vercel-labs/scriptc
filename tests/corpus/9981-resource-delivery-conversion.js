// A deliveryType that cannot convert takes its default and the call still
// buffers its entry, instead of returning with no entry and letting the
// entry build read an empty timeline and abort the process.
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
try {
  performance.markResourceTiming(
    timing(1),
    "https://example.test/ok",
    "fetch",
    undefined,
    "",
    undefined,
    200,
    Symbol("delivery"),
  );
  console.log("accepted");
} catch (error) {
  console.log("threw", error.name, error.message);
}
console.log("entries", performance.getEntriesByType("resource").length, performance.getEntries().length);
