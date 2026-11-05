// A call into Node from a worker thread (tests/harness/node-island.test.ts).
// Node.js initializes once per process, so an island on a second thread
// aborts it; the build refuses this shape (SC8012) instead of compiling a
// crash. The worker entry is this module itself.
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
