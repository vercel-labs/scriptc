// A synchronous program (no timers, no promises) reads the loop milestones
// from its exit listeners: Node's loop starts and stops before them, so both
// are set while no turn was taken.
import { performance } from "node:perf_hooks";

process.on("exit", () => {
  const nt = performance.nodeTiming;
  console.log("sync:", nt.loopStart > 0, nt.loopExit > 0, nt.loopExit >= nt.loopStart);
  console.log("sync turns:", nt.uvMetricsInfo.loopCount, typeof nt.idleTime, nt.idleTime >= 0);
  const elu = performance.eventLoopUtilization();
  console.log("sync elu:", Object.keys(elu).join(","), elu.utilization >= 0 && elu.utilization <= 1);
});
console.log("body");
