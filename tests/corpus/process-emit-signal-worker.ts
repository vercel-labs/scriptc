import { Worker, isMainThread, parentPort } from "node:worker_threads";

// Signal listeners belong to the main thread: a worker's process.emit of a
// signal reaches no listener the main thread registered (the worker's own
// process object has none), so it answers false and the main listener stays
// put.
let runs = 0;
if (isMainThread) {
  process.on("SIGTERM", () => {
    runs += 1;
  });
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (answered: boolean) => {
    console.log("worker answered", answered, "main listener runs", runs);
  });
} else {
  const answered = process.emit("SIGTERM");
  parentPort!.postMessage(answered);
}
