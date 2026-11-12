// perf_hooks.eventLoopUtilization: the module's free function and
// performance.eventLoopUtilization, in their zero-, one- and two-argument
// forms. The numbers themselves are live (they measure the loop), so the
// program pins their shape, key order, and the relations Node guarantees.
import { performance, eventLoopUtilization } from "node:perf_hooks";

const current = eventLoopUtilization();
console.log("keys:", Object.keys(current).join(","));
console.log(
  "types:",
  typeof current.idle,
  typeof current.active,
  typeof current.utilization,
);
console.log("ranges:", current.idle >= 0, current.active >= 0, current.utilization >= 0);
console.log("ratio:", Math.abs(current.utilization - current.active / (current.idle + current.active)) < 1e-9 || current.idle + current.active === 0);

const sample = eventLoopUtilization();
const since = eventLoopUtilization(sample);
console.log("one arg:", Object.keys(since).join(","), since.utilization >= 0, since.active >= 0);
const first = eventLoopUtilization();
const second = eventLoopUtilization();
const between = eventLoopUtilization(first, second);
console.log("two args:", Object.keys(between).join(","), between.utilization >= 0, between.idle <= second.idle);
console.log("json keys:", Object.keys(JSON.parse(JSON.stringify(current))).join(","));
console.log("stringify:", JSON.stringify(current).startsWith('{"idle":'), JSON.stringify(current).includes('"utilization"'));

// The same shapes through performance.eventLoopUtilization.
const method = performance.eventLoopUtilization();
const methodDiff = performance.eventLoopUtilization(method);
console.log("method:", Object.keys(method).join(","), methodDiff.utilization >= 0);

// A checked-dynamic read of the free function's answer.
const dyn: any = eventLoopUtilization();
console.log("dyn:", Object.keys(dyn).join(","), typeof dyn.idle, typeof dyn.utilization, dyn.active >= 0);
console.log("dyn json:", Object.keys(JSON.parse(JSON.stringify(dyn))).join(","));

// Inside the loop the numbers keep their shape and utilization stays a
// ratio; a busy interval counts its CPU time as active.
setImmediate(() => {
  const later = eventLoopUtilization();
  const before = later;
  let spin = 0;
  for (let i = 0; i < 1e5; i++) spin += i;
  const after = eventLoopUtilization(before);
  console.log("later:", later.idle >= 0, typeof after.utilization, after.active >= 0, spin > 0);
});
