// toJSON() reads its receiver once, however many fields the answer reads: a
// side-effecting expression runs one time, not once per field, and the same
// holds for a PerformanceEntry's toJSON.
import { performance, PerformanceEntry } from "node:perf_hooks";

let timingCalls = 0;
function timing() {
  timingCalls += 1;
  return performance.nodeTiming;
}
const json = timing().toJSON();
console.log("nodeTiming keys:", Object.keys(json).join(","));
console.log("nodeTiming calls:", timingCalls);
const rendered = JSON.stringify(timing());
console.log("stringify calls:", timingCalls, Object.keys(JSON.parse(rendered)).join(","));

let entryCalls = 0;
function entry(): PerformanceEntry {
  entryCalls += 1;
  return performance.mark("receiver");
}
const entryJson = entry().toJSON();
console.log("entry keys:", Object.keys(entryJson).sort().join(","));
console.log("entry calls:", entryCalls);
