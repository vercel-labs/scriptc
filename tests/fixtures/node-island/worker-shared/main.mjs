// A module shared with the island (the plugin imports it too) that a worker
// thread also runs. The island has one instance of everything it imports,
// the main thread's, whichever thread calls it; the worker's own code runs
// the worker's instance. Under Node a worker has one instance for both, and
// prints `worker 0/0 1/1 2 2/2` and `main after 2 2`.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { requireModule } from "@scriptc/node";
import { current, record } from "./state.mjs";
const plugin = requireModule("./plugin.mjs");
if (isMainThread) {
  record();
  record();
  console.log("main", current(), plugin.seen());
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message) => console.log(message));
  worker.on("exit", () => console.log("main after", current(), plugin.seen()));
} else {
  const before = `${current()}/${plugin.seen()}`;
  record();
  const mid = `${current()}/${plugin.seen()}`;
  const viaIsland = plugin.bump();
  parentPort.postMessage(`worker ${before} ${mid} ${viaIsland} ${current()}/${plugin.seen()}`);
}
