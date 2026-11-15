// The loop's turn counter advances with the loop's turns: two chained
// immediates take at least two iterations, as Node's loop_count counts them,
// and the exit listener sees the loop's start and end set.
import { performance } from "node:perf_hooks";

setImmediate(() => {
  setImmediate(() => {});
});
process.on("exit", () => {
  const nt = performance.nodeTiming;
  console.log("turns:", nt.uvMetricsInfo.loopCount >= 2, nt.loopStart > 0, nt.loopExit > 0);
});
