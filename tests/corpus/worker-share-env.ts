// worker_threads.SHARE_ENV: the Worker env option that hands the worker this
// process's own environment instead of a copy, so a variable either side sets
// is visible to the other. The symbol is a stable identity, and any other
// symbol is ERR_INVALID_ARG_TYPE like every other non-object env value.
import { SHARE_ENV, Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  process.env.BEFORE = "parent-value";
  const worker = new Worker(new URL(import.meta.url), { env: SHARE_ENV });
  worker.on("message", (message: unknown) => {
    console.log("message:", message, "main sees:", process.env.FROM_WORKER);
    if (message === "done") {
      process.env.AFTER = "parent-later";
      worker.postMessage("go");
    }
  });
  worker.on("exit", (code: number) => {
    console.log("exit:", code, "final:", process.env.BEFORE, process.env.FROM_WORKER, process.env.AFTER);
    try {
      new Worker(new URL(import.meta.url), { env: Symbol("not-shared") as any });
    } catch (error) {
      const shape = error as { code?: string; message?: string };
      console.log("symbol env:", shape.code, shape.message);
    }
    console.log("identity:", SHARE_ENV === SHARE_ENV, typeof SHARE_ENV);
  });
} else {
  console.log("worker sees:", process.env.BEFORE);
  process.env.FROM_WORKER = "worker-value";
  parentPort!.postMessage("done");
  parentPort!.once("message", () => {
    console.log("worker later sees:", process.env.AFTER);
    parentPort!.close();
  });
}
