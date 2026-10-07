import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  await new Promise<void>((resolve) => {
    const worker = new Worker(new URL(import.meta.url));
    console.log("handles", typeof worker.unref(), typeof worker.ref(), worker.threadId > 0);
    worker.once("online", () => console.log("online"));
    worker.once("message", (value: unknown) => console.log("message", value));
    worker.once("exit", (code: number) => { console.log("exit", code, worker.threadId); resolve(); });
  });
  new Worker(new URL(import.meta.url), {workerData: "idle"}).unref();
  console.log("unreferenced worker does not keep parent alive");
} else if (workerData === "idle") {
  setInterval(() => {}, 1000);
} else {
  parentPort!.postMessage(42);
}
