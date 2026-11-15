// A worker thread's own loop emits 'beforeExit' when it runs out of ref'd
// work, exactly the main thread's: the listener runs once, reads the exit
// code as its argument, and the worker then exits normally. Only the
// worker registers a listener, so the event is the worker's even though
// it is `process` — the per-thread loop, as in Node.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const messages: string[] = [];
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => messages.push(message));
  worker.on("exit", (code: number) => {
    console.log("worker exit", code);
    console.log("messages", messages.join("|"));
  });
  console.log("spawned");
} else {
  let emissions = 0;
  process.on("beforeExit", (code: number) => {
    emissions++;
    parentPort!.postMessage(`beforeExit ${code} #${emissions}`);
  });
  parentPort!.postMessage("started");
}
