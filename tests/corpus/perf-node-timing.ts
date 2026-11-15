// performance.nodeTiming: PerformanceNodeTiming's own fields in Node's key
// order, its toJSON (which drops uvMetricsInfo), util.inspect's form,
// JSON.stringify (which runs toJSON first) and the same value read through a
// checked-dynamic slot. Startup milestones print by type only: a compiled
// program has no V8 bootstrap to measure, so they are 0 where Node reads the
// real process's, while the loop milestones are real in both.
import { inspect } from "node:util";
import { performance, PerformanceEntry } from "node:perf_hooks";

const nt = performance.nodeTiming;
console.log("keys:", Object.keys(nt).join(","));
console.log("name/type/start:", nt.name, nt.entryType, nt.startTime);
console.log(
  "milestone types:",
  [nt.nodeStart, nt.v8Start, nt.environment, nt.bootstrapComplete, nt.idleTime, nt.duration]
    .map((value) => typeof value)
    .join(","),
);
console.log("pre-loop:", nt.loopStart, nt.loopExit);
console.log("metrics:", Object.keys(nt.uvMetricsInfo).join(","), typeof nt.uvMetricsInfo.loopCount);
console.log("entry:", nt instanceof PerformanceEntry, Object.getOwnPropertyNames(nt).length);

const json = nt.toJSON();
console.log("toJSON keys:", Object.keys(json).join(","));
console.log("toJSON fields:", json.name, json.entryType, json.startTime);
console.log("stringify keys:", Object.keys(JSON.parse(JSON.stringify(nt))).join(","));
console.log("stringify drops metrics:", JSON.stringify(nt).includes("uvMetricsInfo"));
console.log("inspect:", inspect(nt).split("\n")[0], inspect(nt).includes("uvMetricsInfo"));

// One checked-dynamic read of the same value: the class prototype (toJSON,
// instanceof) and the record's fields answer as the typed read does.
const dyn: any = performance.nodeTiming;
console.log("dyn keys:", Object.keys(dyn).join(","));
console.log("dyn toJSON:", typeof dyn.toJSON, Object.keys(dyn.toJSON()).join(","));
console.log("dyn json keys:", Object.keys(JSON.parse(JSON.stringify(dyn))).join(","));
console.log("dyn entry:", dyn instanceof PerformanceEntry, "toJSON" in dyn);
console.log("dyn metrics:", Object.keys(dyn.uvMetricsInfo).join(","), dyn.uvMetricsInfo.loopCount);

const held: any = { nt: performance.nodeTiming };
console.log("held:", typeof held.nt.toJSON, held.nt.loopStart, held.nt.idleTime >= 0);

// Inside the loop: loopStart is the loop's start, loopExit still -1, and
// the loop's own counters move.
setImmediate(() => {
  const later = performance.nodeTiming;
  console.log("later:", later.loopStart > 0, later.loopExit, later.idleTime >= 0);
  console.log("later metrics:", later.uvMetricsInfo.loopCount >= 1, typeof later.uvMetricsInfo.events);
  console.log("later duration:", typeof later.duration, later.duration >= 0);
});

// After the loop stops, loopExit is set: an exit handler reads it.
process.on("exit", () => {
  const final = performance.nodeTiming;
  console.log("at exit:", final.loopStart > 0, final.loopExit > 0, typeof final.idleTime);
  console.log("at exit metrics:", final.uvMetricsInfo.loopCount >= 1);
});
