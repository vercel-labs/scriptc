// The perf_hooks classes Node 24 defines as globals refuse construction
// where Node does: PerformanceEntry, PerformanceMeasure and
// PerformanceObserverEntryList throw ERR_ILLEGAL_CONSTRUCTOR, a missing
// callback and a missing mark name throw their own TypeErrors, and the
// arguments still evaluate before the throw.
const {
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
} = require("node:perf_hooks");

const attempt = (label, make) => {
  try {
    make();
    console.log(label, "constructed");
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
};

attempt("PerformanceEntry", () => new PerformanceEntry());
attempt("PerformanceMeasure", () => new PerformanceMeasure());
attempt("PerformanceObserverEntryList", () => new PerformanceObserverEntryList());
attempt("PerformanceObserver", () => new PerformanceObserver());
attempt("PerformanceObserver(null)", () => new PerformanceObserver(null));
attempt("PerformanceMark", () => new PerformanceMark());

let evaluated = 0;
const evaluatedName = () => {
  evaluated++;
  return 5;
};
const numeric = new PerformanceMark(evaluatedName());
console.log("numeric name", numeric.name, numeric.entryType, numeric.duration, numeric.detail, evaluated);

const options = () => {
  evaluated++;
  return { startTime: 4.5 };
};
console.log(new PerformanceMark("opts", options()).startTime, evaluated);
