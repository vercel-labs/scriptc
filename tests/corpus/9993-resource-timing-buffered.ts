// observe({ type: 'resource', buffered: true }) replays the resource
// entries already in the timeline (in startTime order) and then reports
// entries that land later; disconnect stops the delivery.
import { performance, PerformanceObserver } from "node:perf_hooks";

performance.markResourceTiming(
  { startTime: 3, endTime: 4, encodedBodySize: 1, decodedBodySize: 1 },
  "second",
  "fetch",
  {},
  "",
  {},
  0,
);
performance.markResourceTiming(
  { startTime: 1, endTime: 2, encodedBodySize: 1, decodedBodySize: 1 },
  "first",
  "fetch",
  {},
  "",
  {},
  0,
);
const seen: string[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) seen.push(`${entry.entryType}:${entry.name}`);
});
observer.observe({ type: "resource", buffered: true });
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("buffered", seen.join(","));
performance.markResourceTiming(
  { startTime: 5, endTime: 6, encodedBodySize: 1, decodedBodySize: 1 },
  "third",
  "fetch",
  {},
  "",
  {},
  0,
);
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("after", seen.join(","));
observer.disconnect();
performance.markResourceTiming(
  { startTime: 7, endTime: 8, encodedBodySize: 1, decodedBodySize: 1 },
  "fourth",
  "fetch",
  {},
  "",
  {},
  0,
);
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("disconnected", seen.join(","));
