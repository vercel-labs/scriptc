// A timer the loop runs takes at least one turn: the exit listener reads a
// loopCount above zero, and the loop's start and end are set.
import { performance } from "node:perf_hooks";

setTimeout(() => {}, 1);
process.on("exit", () => {
  const nt = performance.nodeTiming;
  console.log("timer turns:", nt.uvMetricsInfo.loopCount >= 1, nt.loopStart > 0, nt.loopExit > 0);
});
