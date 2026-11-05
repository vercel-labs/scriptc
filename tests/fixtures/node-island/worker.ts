// A call into Node from a worker thread (tests/harness/node-island.test.ts):
// the island belongs to the thread that started it (the main thread), so the
// worker's operations are posted to that thread and answered there — a
// synchronous call works. An asynchronous call would have to settle a
// promise on another thread's loop, so it rejects by name instead.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { call, callSync } from "@scriptc/node";

if (isMainThread) {
  console.log("main", callSync<number>("./helper.cjs", "answer"));
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => console.log("worker", message));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.postMessage("called " + callSync<number>("./helper.cjs", "answer"));
  call("./helper.cjs", "answer").then(
    () => parentPort!.postMessage("async called"),
    (error: unknown) => parentPort!.postMessage("async " + (error as { code?: string }).code),
  );
}
