// Node 24 defines the perf_hooks classes as globals, so a program that never
// imports the module reaches the same constructors: new PerformanceMark
// builds an entry outside the timeline, PerformanceObserver buffers and
// delivers the entries a mark or measure produced, and the entry classes
// answer instanceof. The three classes Node keeps unconstructible throw
// ERR_ILLEGAL_CONSTRUCTOR through the global name too.
const mark = new PerformanceMark("global first", { startTime: 2 });
console.log(
  mark.name,
  mark.entryType,
  mark.startTime,
  mark instanceof PerformanceEntry,
  mark instanceof PerformanceMark,
);
console.log(performance.getEntriesByName("global first").length);

const drained = new PerformanceObserver(() => console.log("drained callback"));
drained.observe({ entryTypes: ["measure"] });
performance.measure("drained span", { start: 1, end: 3 });
const taken = drained.takeRecords();
console.log("taken", taken.length, taken[0] instanceof PerformanceMeasure);
drained.disconnect();

const delivered = new PerformanceObserver((list) => {
  console.log(
    "delivered",
    list.getEntries().length,
    list.getEntriesByType("measure").length,
    list.getEntriesByName("global span").length,
    list.getEntriesByName("global span", "measure").length,
  );
  for (const entry of list.getEntriesByType("measure"))
    console.log("measure entry", entry instanceof PerformanceMeasure);
});
delivered.observe({ entryTypes: ["measure"] });
performance.measure("global span", { start: 1, end: 3 });

try {
  new PerformanceEntry();
} catch (error) {
  console.log("global PerformanceEntry", error.name, error.code);
}
try {
  new PerformanceObserverEntryList();
} catch (error) {
  console.log("global PerformanceObserverEntryList", error.name, error.code);
}
try {
  new PerformanceMeasure();
} catch (error) {
  console.log("global PerformanceMeasure", error.name, error.code);
}
