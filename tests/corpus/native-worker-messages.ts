import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
let moduleCounter = 0;
function bump(): number { return ++moduleCounter; }
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { seed: 41 } });
  worker.on("message", (value: unknown) => console.log(JSON.stringify(value)));
  worker.on("exit", (code: number) => console.log("exit", code, "main", bump()));
  worker.postMessage(1);
} else {
  const port = parentPort!;
  const data = workerData as { seed: number };
  port.once("message", (value: unknown) => {
    port.postMessage({ result: data.seed + (value as number), counter: bump() });
  });
}
