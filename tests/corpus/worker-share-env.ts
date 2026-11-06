// worker_threads.SHARE_ENV: the Worker env option that hands the worker this
// thread's own environment instead of a copy, so a variable either side sets
// is visible to the other. A worker that was itself created with a private
// env shares that environment with a SHARE_ENV child, not the process
// environment its own parent reads. The symbol is a stable identity with
// Node's description, and any other symbol is ERR_INVALID_ARG_TYPE like every
// other non-object env value.
import { SHARE_ENV, Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

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
    console.log("description:", SHARE_ENV.description, SHARE_ENV.description?.length, String(SHARE_ENV));
    // A worker with a private environment, sharing it with its own children.
    const nested = new Worker(new URL(import.meta.url), { workerData: "nested", env: { MID_ONLY: "mid" } });
    nested.on("message", (message: unknown) => console.log("nested:", JSON.stringify(message)));
    nested.on("exit", (code2: number) => {
      console.log(
        "nested exit:",
        code2,
        "main mid:",
        process.env.MID_ONLY === undefined,
        process.env.CHILD_NEW === undefined,
      );
    });
  });
} else if (workerData === "nested") {
  console.log("nested worker env:", process.env.MID_ONLY, "before absent:", process.env.BEFORE === undefined);
  const copy = new Worker(new URL(import.meta.url), { workerData: "copy-child" });
  copy.on("message", (message: unknown) => {
    console.log("copy child:", JSON.stringify(message));
    copy.terminate();
    const shared = new Worker(new URL(import.meta.url), { workerData: "shared-child", env: SHARE_ENV });
    shared.on("message", (message: unknown) => {
      console.log("shared child:", JSON.stringify(message));
      shared.terminate();
      parentPort!.postMessage(["mid after:", process.env.MID_ONLY, "mid new:", process.env.CHILD_NEW]);
      parentPort!.close();
    });
  });
} else if (workerData === "copy-child") {
  parentPort!.postMessage(["mid only:", process.env.MID_ONLY, "before absent:", process.env.BEFORE === undefined]);
} else if (workerData === "shared-child") {
  const before = process.env.MID_ONLY;
  const beforeAbsent = process.env.BEFORE === undefined;
  process.env.MID_ONLY = "set-by-child";
  process.env.CHILD_NEW = "child-new";
  parentPort!.postMessage(["before:", before, "before absent:", beforeAbsent, "after:", process.env.MID_ONLY]);
} else {
  console.log("worker sees:", process.env.BEFORE);
  process.env.FROM_WORKER = "worker-value";
  parentPort!.postMessage("done");
  parentPort!.once("message", () => {
    console.log("worker later sees:", process.env.AFTER);
    parentPort!.close();
  });
}
