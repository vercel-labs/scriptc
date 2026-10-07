import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  const shared = new SharedArrayBuffer(4);
  const worker = new Worker(new URL(import.meta.url), { workerData: shared });
  worker.on("message", () => {
    // The worker may already be parked, or may reach wait after cancellation.
    worker.terminate().then((code: number) => console.log("terminated", code));
  });
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  const values = new Int32Array(workerData as SharedArrayBuffer);
  parentPort!.postMessage("ready");
  try {
    Atomics.wait(values, 0, 0, undefined);
    console.log("unexpected wake");
  } catch {
    console.log("unexpected catch");
  } finally {
    console.log("unexpected finally");
  }
}
