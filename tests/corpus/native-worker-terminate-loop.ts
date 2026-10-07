import { Worker, isMainThread, parentPort } from "node:worker_threads";
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", async () => {
    console.log("ready");
    console.log("terminated", await worker.terminate());
  });
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.postMessage("ready");
  try { while (true) {} } catch { console.log("caught"); } finally { console.log("finally"); }
}
