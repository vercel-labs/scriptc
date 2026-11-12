// A connected observer's callback runs from the check phase, so a program
// whose only pending work is that delivery still runs the event loop: the
// marks made after observe() arrive in one callback after the synchronous
// body, in the order they were made, and each is a PerformanceMark.
import {
  performance,
  PerformanceMark,
  PerformanceObserver,
  PerformanceObserverEntryList,
} from "node:perf_hooks";

const observer = new PerformanceObserver((list: PerformanceObserverEntryList) => {
  for (const entry of list.getEntries())
    console.log("delivered", entry.entryType, entry.name, entry instanceof PerformanceMark);
});
observer.observe({ entryTypes: ["mark"] });

performance.mark("first", { startTime: 1 });
performance.mark("second", { startTime: 2 });
console.log("body");
