// A Worker entry the build can bound (wave2 §4.2): the parameter of the
// module-local `start` receives a module-local function's return value, and
// the entry is a URL resolved against this module. Every call of both
// functions is direct, so each bounded value is a native worker root and the
// site selects on Node's normalized path.
import { Worker } from "node:worker_threads";

function entryName(): string {
  return import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js";
}

function start(specifier: string, data: number): Promise<number> {
  return new Promise<number>((resolve) => {
    const worker = new Worker(new URL(specifier, import.meta.url), { workerData: data });
    worker.once("message", (value: number) => resolve(value));
  });
}

console.log("worker", await start(entryName(), 21));
