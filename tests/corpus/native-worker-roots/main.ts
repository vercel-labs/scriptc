import { Worker } from "node:worker_threads";

for (const round of [1, 2]) {
  const jobs: Promise<number>[] = [
    new Promise<number>((resolve) => {
      const worker = new Worker(new URL("./sum.ts", import.meta.url), {workerData: round});
      worker.once("message", (value: number) => resolve(value));
    }),
    new Promise<number>((resolve) => {
      const worker = new Worker(new URL("./product.ts", import.meta.url), {workerData: round});
      worker.once("message", (value: number) => resolve(value));
    }),
  ];
  const result = await Promise.all(jobs);
  console.log(JSON.stringify(result));
}
