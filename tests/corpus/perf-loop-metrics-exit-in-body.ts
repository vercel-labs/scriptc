// process.exit() inside the main body never starts the loop: the exit
// listeners see the loop milestones at -1, as Node reports them.
import { performance } from "node:perf_hooks";

process.on("exit", () => {
  const nt = performance.nodeTiming;
  console.log("exit in body:", nt.loopStart, nt.loopExit, nt.uvMetricsInfo.loopCount);
});
console.log("before exit");
process.exit(0);
