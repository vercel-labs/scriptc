import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);

// worker.performance.eventLoopUtilization([util1[, util2]]): the worker
// thread's own loop metrics. Zero before the online event and after exit; with
// two readings it reports their difference, which is exact; the live numbers
// belong to the machine, so the program prints their shape after a few turns
// through the loop and the arithmetic only.
if (isMainThread) {
  const worker = new Worker(self);
  const keys = (elu: object) => Object.keys(elu).join(",");
  const zeros = (elu: { idle: number; active: number; utilization: number }) =>
    `${keys(elu)} zero=${elu.idle === 0 && elu.active === 0 && elu.utilization === 0}`;
  console.log("before online", zeros(worker.performance.eventLoopUtilization()));

  // The parent blocks before it can deliver the worker's 'online' event, so the
  // worker's loop has surely published by the read: Node still answers the zero
  // object until the event is delivered.
  const until = Date.now() + 100;
  while (Date.now() < until) {}
  console.log("before delivery", zeros(worker.performance.eventLoopUtilization()));

  const first = { idle: 10, active: 30, utilization: 0.75 };
  const second = { idle: 4, active: 16, utilization: 0.8 };
  let turns = 0;

  const read = () => {
    const pair = worker.performance.eventLoopUtilization(first, second);
    console.log("two readings", JSON.stringify(pair));
    const live = worker.performance.eventLoopUtilization();
    console.log(
      "live",
      keys(live),
      live.idle > 0,
      live.active > 0,
      live.utilization > 0 && live.utilization < 1,
    );
    const since = worker.performance.eventLoopUtilization(live);
    console.log("since reading", keys(since), Number.isFinite(since.idle), Number.isFinite(since.active));
    worker.terminate();
  };

  worker.on("online", () => worker.postMessage(turns));
  worker.on("message", () => {
    if (++turns < 3) setTimeout(() => worker.postMessage(turns), 20);
    else setTimeout(read, 20);
  });
  worker.on("exit", () => console.log("after exit", zeros(worker.performance.eventLoopUtilization())));
} else {
  // A turn per message: the metrics a reading sees come from the turns before
  // it, so the exchange gives the loop time to report a non-zero idle.
  parentPort!.on("message", (value: number) => parentPort!.postMessage(value));
}
