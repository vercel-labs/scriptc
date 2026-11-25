// performance.nodeTiming, performance.toJSON and
// PerformanceObserver.supportedEntryTypes from a JavaScript program: the
// same values, read through the destructured require binding, with only
// the types the ambient declarations give them.
const { performance, PerformanceObserver, eventLoopUtilization } = require("node:perf_hooks");
const { inspect } = require("node:util");

const nt = performance.nodeTiming;
console.log("keys:", Object.keys(nt).join(","));
console.log("name/type:", nt.name, nt.entryType, nt.startTime, nt.loopStart, nt.loopExit);
console.log("toJSON keys:", Object.keys(nt.toJSON()).join(","));
console.log("json keys:", Object.keys(JSON.parse(JSON.stringify(nt))).join(","));
console.log("metrics:", Object.keys(nt.uvMetricsInfo).join(","));
console.log("inspect:", inspect(nt).split("\n")[0]);

const types = PerformanceObserver.supportedEntryTypes;
console.log(
  "types:",
  types === PerformanceObserver.supportedEntryTypes,
  Object.isFrozen(types),
  JSON.stringify(types),
);

const answer = performance.toJSON();
console.log("toJSON keys:", Object.keys(answer).join(","));
console.log("toJSON nested:", Object.keys(answer.nodeTiming).join(","));
console.log("toJSON json:", Object.keys(JSON.parse(JSON.stringify(answer))).join(","));

// Checked-dynamic reads of the same values.
const anyNt = performance.nodeTiming;
console.log("dyn keys:", Object.keys(anyNt).join(","));
console.log("dyn toJSON:", Object.keys(anyNt.toJSON()).join(","));
console.log("dyn json:", Object.keys(JSON.parse(JSON.stringify(anyNt))).join(","));
const anyTypes = PerformanceObserver.supportedEntryTypes;
console.log("dyn types:", anyTypes === PerformanceObserver.supportedEntryTypes, Object.isFrozen(anyTypes));

const util1 = performance.eventLoopUtilization();
const util2 = performance.eventLoopUtilization(util1);
console.log("elu:", Object.keys(util1).join(","), typeof util1.utilization, util2.utilization >= 0);

// The module's free function: the same function as the method, and the
// one- and two-argument forms answer the same shape.
const free = eventLoopUtilization();
const pair = eventLoopUtilization(free, util1);
console.log(
  "free elu:",
  Object.keys(free).join(","),
  typeof free.utilization,
  eventLoopUtilization(free).utilization >= 0,
  pair.utilization >= 0,
);

setImmediate(() => {
  const later = performance.nodeTiming;
  console.log("later:", later.loopStart > 0, later.loopExit, later.uvMetricsInfo.loopCount >= 1);
});
