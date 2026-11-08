// @requires-libnode
// A worker thread is the first thread to reach a Node island, while the
// main thread waits for its message: Node starts on the main thread, which
// then serves the worker's call. The main thread uses the island after the
// worker ended, and an idle second worker makes one call.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { workerData: "first" });
  worker.on("message", (message) => console.log("worker", message));
  worker.on("exit", (code) => {
    console.log("exit", code);
    const lib = requireModule("./lib.cjs");
    console.log("main", lib.echo("after"));
    const second = new Worker(new URL(import.meta.url), { workerData: "second" });
    second.on("message", (message) => console.log("worker", message));
    second.on("exit", (code) => console.log("exit", code));
  });
} else {
  const lib = requireModule("./lib.cjs");
  parentPort.postMessage(lib.echo(workerData));
}
