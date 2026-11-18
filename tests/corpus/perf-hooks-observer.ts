// PerformanceObserver's documented flow: buffered delivery of entries made
// before observe, type-based and entryTypes-based observation, a callback
// per batch with the observer itself as its second argument, the entry
// list's selectors, takeRecords, and disconnect stopping delivery.
import { PerformanceObserver, performance } from "node:perf_hooks";

const buffered: string[] = [];
const early = new PerformanceObserver((list, self) => {
  buffered.push(list.getEntries().map((e) => e.name).join(","));
  buffered.push(self === early ? "self" : "other");
});
performance.mark("before", { startTime: 1 });
early.observe({ entryTypes: ["mark"], buffered: true });
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("buffered", buffered.join("|"));

const typed: string[] = [];
const byType = new PerformanceObserver((list) => {
  typed.push(list.getEntries().map((e) => `${e.name}:${e.entryType}`).join(","));
});
byType.observe({ type: "measure" });
performance.measure("m1", { start: 1, duration: 1 });
performance.mark("not-typed", { startTime: 2 });
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("typed", typed.join("|"));
console.log("typed records", byType.takeRecords().length);

const selectors: string[] = [];
const both = new PerformanceObserver((list) => {
  selectors.push(String(list.getEntries().length));
  selectors.push(String(list.getEntriesByType("mark").length));
  selectors.push(String(list.getEntriesByName("shared", "measure").length));
  selectors.push(String(list.getEntriesByName("shared", "mark").length));
});
both.observe({ entryTypes: ["mark", "measure"] });
performance.mark("shared", { startTime: 3 });
performance.measure("shared", { start: 3, duration: 1 });
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("selectors", selectors.join(","));

early.disconnect();
byType.disconnect();
both.disconnect();
performance.mark("after", { startTime: 4 });
await new Promise((resolve) => setTimeout(resolve, 5));
console.log("after", buffered.length, typed.length, selectors.length);
console.log("disconnected records", early.takeRecords().length);
