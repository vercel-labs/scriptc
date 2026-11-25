// The pi `host.ts` shape (wave2 §4.2): `options.workerUrl ?? defaultWorkerUrl()`.
// `workerUrl` is a member of an exported option type, so its value cannot be
// bounded; the bound is PARTIAL — the URL value is a native worker root and
// the Top member keeps the residual arm.
import { Worker } from "node:worker_threads";

interface Options {
  workerUrl?: URL;
}

function defaultWorkerUrl(): URL {
  return new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
}

function start(options: Options): Promise<number> {
  return new Promise<number>((resolve) => {
    const worker = new Worker(options.workerUrl ?? defaultWorkerUrl(), { workerData: 21 });
    worker.once("message", (value: number) => resolve(value));
  });
}

console.log("worker", await start({}));
