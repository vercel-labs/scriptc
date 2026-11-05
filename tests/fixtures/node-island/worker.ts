// A call into Node from a worker thread (tests/harness/node-island.test.ts):
// Node islands run on the main thread only, so the worker's call throws.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { callSync } from "@scriptc/node";

if (isMainThread) {
  console.log("main", callSync<number>("./helper.cjs", "answer"));
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => console.log("worker", message));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  try {
    callSync<number>("./helper.cjs", "answer");
    parentPort!.postMessage("called");
  } catch (error) {
    parentPort!.postMessage((error as Error).message);
  }
}
