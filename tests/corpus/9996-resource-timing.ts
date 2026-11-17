// perf_hooks resource timing: performance.markResourceTiming builds a
// PerformanceResourceTiming from fetch's timing info (every field and its
// toJSON), buffers it in the resource timeline, and the getEntries family
// returns it beside marks and measures in startTime order. The class is
// also a global, and instanceof tells it apart from the other entries.
import {
  performance,
  PerformanceEntry,
  PerformanceResourceTiming,
} from "node:perf_hooks";

const timingInfo = {
  startTime: 10,
  endTime: 50,
  redirectStartTime: 0,
  redirectEndTime: 0,
  postRedirectStartTime: 12,
  finalServiceWorkerStartTime: 0,
  finalNetworkRequestStartTime: 14,
  finalNetworkResponseStartTime: 20,
  firstInterimNetworkResponseStartTime: 0,
  encodedBodySize: 100,
  decodedBodySize: 90,
  renderBlocking: false,
  finalConnectionTimingInfo: {
    domainLookupStartTime: 1,
    domainLookupEndTime: 2,
    connectionStartTime: 3,
    connectionEndTime: 4,
    secureConnectionStartTime: 0,
    ALPNNegotiatedProtocol: "h2",
  },
};
const bodyInfo = { contentType: "text/plain", contentEncoding: "gzip" };

performance.mark("first", { startTime: 5 });
const entry = performance.markResourceTiming(
  timingInfo,
  "https://example.test/a",
  "fetch",
  {},
  "",
  bodyInfo,
  200,
);

console.log("identity", entry.name, entry.entryType, entry.startTime, entry.duration);
console.log(
  "fields",
  entry.initiatorType,
  entry.nextHopProtocol,
  entry.workerStart,
  entry.redirectStart,
  entry.redirectEnd,
  entry.fetchStart,
  entry.domainLookupStart,
  entry.domainLookupEnd,
  entry.connectStart,
  entry.connectEnd,
  entry.secureConnectionStart,
  entry.requestStart,
  entry.finalResponseHeadersStart,
  entry.firstInterimResponseStart,
  entry.responseStart,
  entry.responseEnd,
  entry.transferSize,
  entry.encodedBodySize,
  entry.decodedBodySize,
  entry.deliveryType,
  entry.responseStatus,
  entry.renderBlockingStatus,
  entry.contentType,
  entry.contentEncoding,
);
console.log("json", JSON.stringify(entry.toJSON()));
console.log("instanceof", entry instanceof PerformanceResourceTiming, entry instanceof Error);
console.log("string", String(entry));

const listed = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
console.log("by type", listed.length, listed[0] === undefined ? "-" : listed[0].connectEnd);
const all = performance.getEntries();
console.log("all", all.map((each) => `${each.entryType}:${each.name}`).join(","));
// An entry keeps its runtime class through a PerformanceEntry-typed value
// and through an entry array: serializing either runs the resource toJSON
// (timing fields, no detail).
const asEntry: PerformanceEntry = listed[0]!;
console.log("entry json", JSON.stringify(asEntry));
console.log("entry toJSON", JSON.stringify(asEntry.toJSON()));
console.log("array json", JSON.stringify(performance.getEntriesByType("resource")));

// A cached resource transfers nothing; a local one 300 bytes.
const cached = performance.markResourceTiming(
  { startTime: 1, endTime: 2, encodedBodySize: 7, decodedBodySize: 7 },
  "cache",
  "fetch",
  {},
  "local",
  {},
  0,
);
console.log("cache", cached.transferSize, cached.contentType, cached.renderBlockingStatus);

performance.clearResourceTimings("missing");
console.log("kept", performance.getEntriesByType("resource").length);
performance.setResourceTimingBufferSize(1);
const extra = performance.markResourceTiming(
  { startTime: 3, endTime: 4, encodedBodySize: 1, decodedBodySize: 1 },
  "dropped",
  "fetch",
  {},
  "",
  {},
  0,
);
console.log("limit", performance.getEntriesByType("resource").length, extra.name);
performance.clearResourceTimings();
console.log("cleared", performance.getEntriesByType("resource").length);
