// takeRecords() empties an observer's queue but leaves the scheduled
// delivery in place: Node still runs the callback, with the entries that
// arrived after the take (or none), and a second takeRecords() answers
// nothing. The entries takeRecords answers are the program's own mark and
// measure objects, and a selector reached through a checked-dynamic
// receiver answers that same object too. The instanceof operand evaluates
// before the answer, so its side effects happen.
import { performance, PerformanceObserver } from "node:perf_hooks";

const first = new PerformanceObserver((list) => {
  console.log("first callback", list.getEntries().length);
});
first.observe({ entryTypes: ["mark"] });
const second = performance.mark("second", { startTime: 2 });
const taken = first.takeRecords();
console.log("taken", taken.length, taken[0].name, taken[0] === second);

const measures = new PerformanceObserver((list) => {
  console.log("measure callback", list.getEntries().length);
});
measures.observe({ entryTypes: ["measure"] });
const span = performance.measure("span", { start: 1, end: 2 });
const measureTaken = measures.takeRecords();
console.log("measure taken", measureTaken.length, measureTaken[0] === span);

const dynamic = new PerformanceObserver((list) => {
  const entriesOf = (source: any): any[] => source.getEntries();
  const entries = entriesOf(list);
  console.log("dynamic identity", entries[0] === performance.getEntriesByName("dyn mark")[0]);
});
dynamic.observe({ entryTypes: ["mark"] });
performance.mark("dyn mark");

function produce() {
  console.log("operand");
  return performance.mark("side effect");
}
console.log("instanceof", produce() instanceof PerformanceEntry);
