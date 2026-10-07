import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  try {
    worker.postMessage(() => {});
  } catch (error) {
    if (error instanceof Error) console.log("clone", error.name);
    else throw error;
  }
  const transfer: unknown[] = [];
  worker.postMessage(42, transfer);
  worker.on("message", (value: unknown) => console.log("reply", value));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.once("message", (value: unknown) => parentPort!.postMessage(value));
}
