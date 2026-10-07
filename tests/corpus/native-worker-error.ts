import { Worker, isMainThread } from "node:worker_threads";
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("error", (error: Error) => console.log(error.name, error.message, error instanceof TypeError));
  worker.on("exit", (code: number) => console.log("exit", code));
} else { throw new TypeError("worker failed"); }
