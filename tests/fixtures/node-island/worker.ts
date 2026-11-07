// A call into Node from a worker thread (tests/harness/node-island.test.ts):
// the island belongs to the thread that started it (the main thread), so the
// worker's operations are posted to that thread and answered there — a
// synchronous call works. An asynchronous call, and awaiting an island value,
// would have to settle a promise on another thread's loop, so they reject by
// name instead.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { call, callSync, requireModule } from "@scriptc/node";
import { parts } from "thenable-pkg";

if (isMainThread) {
  console.log("main", callSync<number>("./helper.cjs", "answer"));
  // The island keeps a native object by reference: the export is the island
  // thread's object, so a worker asking for it back is refused by code.
  requireModule("./helper.cjs").keep({ tag: "kept" });
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => console.log("worker", message));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.postMessage("called " + callSync<number>("./helper.cjs", "answer"));
  // The value the main thread kept: a native object passed by reference
  // belongs to the island's thread, so the worker's retrieval is refused.
  try {
    requireModule("./helper.cjs").get();
    parentPort!.postMessage("get taken");
  } catch (error) {
    parentPort!.postMessage("get " + (error as { code?: string }).code);
  }
  call("./helper.cjs", "answer").then(
    () => parentPort!.postMessage("async called"),
    (error: unknown) => parentPort!.postMessage("async " + (error as { code?: string }).code),
  );
  // parts() answers a thenable: the worker holds it (a promise is refused
  // crossing into a thread, ERR_SCRIPTC_ISLAND_WORKER_VALUE), and awaiting
  // it would register the waiter in the island thread's table and settle
  // the promise there, so the await rejects by name like the call above.
  parts().then(
    (values) => parentPort!.postMessage("await " + values.length),
    (error: unknown) => parentPort!.postMessage("await " + (error as { code?: string }).code),
  );
}
