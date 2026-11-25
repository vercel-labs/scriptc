// performance.timerify wraps a function, records a 'function' entry whose
// detail is the argument list for the observers (never the timeline), passes
// `this` and thrown errors through, and validates fn/options like Node.
import {
  performance,
  timerify,
  PerformanceObserver,
  createHistogram,
  monitorEventLoopDelay,
} from "node:perf_hooks";

const seen = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    seen.push(`${entry.entryType}:${entry.name}:${typeof entry.duration}:${JSON.stringify(entry.detail)}`);
  }
});
observer.observe({ entryTypes: ["function"] });

console.log("module", typeof timerify, typeof performance.timerify);
function original(a, b) {
  return a + b;
}
const wrapped = performance.timerify(original);
console.log("wrapper", wrapped.name, wrapped.length, Object.prototype.toString.call(wrapped));
console.log(
  "prototype",
  Object.keys(wrapped.prototype).length,
  wrapped.prototype.constructor === wrapped,
  Object.getOwnPropertyDescriptor(wrapped, "prototype").writable,
);
console.log("call", wrapped(1, 2));

const obj = {
  tag: "T",
  method(a) {
    return this.tag + a;
  },
};
const timedMethod = performance.timerify(obj.method);
console.log("this", timedMethod.call(obj, "!"));

const timedBoom = performance.timerify(function boom() {
  throw new Error("boom");
});
try {
  timedBoom(1, 2);
} catch (error) {
  console.log("throws", error.message);
}

// A wrapper is a constructor too: `new` constructs the original and records
// the call, and the instance is the original's (the wrapper's own prototype
// plays no part).
function Point(x, y) {
  this.x = x;
  this.y = y;
}
Point.prototype.sum = function sum() {
  return this.x + this.y;
};
const TimedPoint = performance.timerify(Point);
const point = new TimedPoint(3, 4);
console.log("construct", point.x, point.y, point.sum(), point instanceof Point, point instanceof TimedPoint);

// An async call's entry lands when its promise settles, timed over the whole
// call, and a rejection records too while still rejecting.
const timedAsync = performance.timerify(async function gather(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ms * 2;
});
console.log("async", await timedAsync(20));
await new Promise((resolve) => setTimeout(resolve, 20));
const timedReject = performance.timerify(async function losing() {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw new Error("nope");
});
try {
  await timedReject();
  console.log("reject missing");
} catch (error) {
  console.log("async throws", error.message);
}
await new Promise((resolve) => setTimeout(resolve, 20));

// options.histogram: each completed call's duration lands in the histogram as
// a rounded-up nanosecond count.
const histogram = createHistogram();
const timedSum = performance.timerify(
  function sum(a, b) {
    return a + b;
  },
  { histogram },
);
timedSum(1, 2);
timedSum(3, 4);
console.log("histogram", histogram.count, histogram.min >= 1, histogram.max >= 1);

// Any promise-like result (one whose finally is callable) defers the entry
// to that finally and answers what finally returns.
const thenable = {
  tag: "thenable",
  finally(callback) {
    callback();
    return `settled:${this.tag}`;
  },
};
const timedThenable = performance.timerify(function shape() {
  return thenable;
});
console.log("thenable", timedThenable());

// A finally that is not callable is no promise-like: the call is recorded
// itself and its result returned as it stands.
const notFinally = { finally: 5 };
const timedPlain = performance.timerify(function plain() {
  return notFinally;
});
console.log("not-finally", timedPlain() === notFinally);

await new Promise((resolve) => setTimeout(resolve, 20));
observer.disconnect();
console.log("seen", seen.join(" | "));
console.log("timeline", performance.getEntriesByType("function").length);

// The invalid forms are checked at run time; the declarations type the
// arguments, so each call passes the offending value through an untyped
// cast while the call itself stays the lowered performance.timerify.
for (const [label, run] of [
  ["fn", () => performance.timerify(/** @type {any} */ (5))],
  ["fn-undefined", () => performance.timerify(/** @type {any} */ (undefined))],
  ["options-null", () => performance.timerify(original, /** @type {any} */ (null))],
  ["options-array", () => performance.timerify(original, /** @type {any} */ ([]))],
  ["options-number", () => performance.timerify(original, /** @type {any} */ (5))],
  ["histogram-number", () => performance.timerify(original, /** @type {any} */ ({ histogram: 5 }))],
  ["histogram-object", () => performance.timerify(original, /** @type {any} */ ({ histogram: {} }))],
  [
    "histogram-interval",
    () => performance.timerify(original, /** @type {any} */ ({ histogram: monitorEventLoopDelay() })),
  ],
]) {
  try {
    run();
    console.log("accepted", label);
  } catch (error) {
    console.log("invalid", label, error.name, error.code, error.message);
  }
}
