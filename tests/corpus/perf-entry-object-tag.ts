// Object.prototype.toString over a perf_hooks entry answers the class tag
// Node's prototypes carry: a mark is [object PerformanceMark] and a measure
// [object PerformanceMeasure], whichever way the entry was made (mark,
// measure, a constructor, or a reader). The entry's own toString() and
// String() conversions answer the same, and a plain object it derives from
// stays [object Object].
import { PerformanceMark, performance } from "node:perf_hooks";

const mark = performance.mark("made", { startTime: 1, detail: { a: 1 } });
const measure = performance.measure("span", { start: 1, duration: 2 });
const constructed = new PerformanceMark("built", { startTime: 3 });

console.log(Object.prototype.toString.call(mark));
console.log(Object.prototype.toString.call(measure));
console.log(Object.prototype.toString.call(constructed));
console.log(mark.toString(), measure.toString(), String(constructed));
console.log(`${mark}`);

const marks = performance.getEntriesByType("mark");
const measures = performance.getEntriesByType("measure");
console.log(Object.prototype.toString.call(marks[0]!), Object.prototype.toString.call(measures[0]!));
console.log(Object.prototype.toString.call(mark.toJSON()), Object.prototype.toString.call({}));
console.log(Object.prototype.toString.call(mark), Object.prototype.toString.call(measure));
