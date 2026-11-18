// performance.timerify wraps a function, records a 'function' entry whose
// detail is the argument list for the observers (never the timeline), passes
// `this` and thrown errors through, and validates fn/options like Node.
import { performance, timerify, PerformanceObserver } from "node:perf_hooks";

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

await new Promise((resolve) => setTimeout(resolve, 20));
observer.disconnect();
console.log("seen", seen.join(" | "));
console.log("timeline", performance.getEntriesByType("function").length);

for (const [label, run] of [
  ["fn", () => performance.timerify(5)],
  ["fn-missing", () => performance.timerify()],
  ["options-null", () => performance.timerify(original, null)],
  ["options-array", () => performance.timerify(original, [])],
  ["options-number", () => performance.timerify(original, 5)],
]) {
  try {
    run();
    console.log("accepted", label);
  } catch (error) {
    console.log("invalid", label, error.name, error.code, error.message);
  }
}
