// @requires-libnode
// The Node island belongs to the thread that started it (K4): a native
// worker thread reaches the same island through its own handle, and every
// operation it makes is posted to the island's thread and answered there.
// Both threads call the island in the same turns, so a shared ref count or a
// second Node start shows up as an abort or as a wrong answer.
import { requireModule } from "@scriptc/node";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

if (isMainThread) {
  const lib = requireModule("./lib.cjs");
  let calls = 0;
  let mainSum = 0;
  const timer = setInterval(() => {
    calls++;
    mainSum += lib.create(lib.params()).length;
  }, 1);
  // The first ticks land before the worker starts, so the two threads then
  // use the island in the same turns.
  setTimeout(() => {
    const worker = new Worker(new URL(import.meta.url));
    worker.on("message", (workerSum) => {
      clearInterval(timer);
      // Called after the worker stopped: the island is still the same one.
      mainSum += lib.create(lib.params()).length;
      console.log("worker", workerSum, "main", mainSum > 0, "calls", calls > 0);
    });
    worker.on("exit", (code) => console.log("exit", code));
  }, 20);
} else {
  const lib = requireModule("./lib.cjs");
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += lib.create(lib.params()).length;
  parentPort.postMessage(sum);
}
