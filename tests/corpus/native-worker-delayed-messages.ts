import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (value: unknown) => console.log(JSON.stringify(value)));
  worker.on("exit", (code: number) => console.log("exit", code));
  worker.postMessage(20);
  worker.postMessage(22);
} else {
  const values: number[] = [];
  setTimeout(() => {
    parentPort!.on("message", (value: unknown) => {
      values.push(value as number);
      if (values.length === 2) {
        parentPort!.postMessage(values);
        parentPort!.close();
      }
    });
  }, 20);
}
