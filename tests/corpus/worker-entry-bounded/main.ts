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

// A helper that builds the URL from its own parameter: the value it returns
// is bounded from the helper's call sites. One call names a URL the Worker
// constructor rejects. Both arguments are evaluated before the constructor
// reads the filename, so the options expression runs and then it throws.
function entryUrl(specifier: string): URL {
  return new URL(specifier, import.meta.url);
}

function options(data: number): { workerData: number } {
  console.log("options", data);
  return { workerData: data };
}

function launch(entry: URL, data: number): Promise<number> {
  return new Promise<number>((resolve) => {
    const worker = new Worker(entry, options(data));
    worker.once("message", (value: number) => resolve(value));
  });
}

console.log("worker", await launch(entryUrl(entryName()), 4));
try {
  await launch(entryUrl("https://example.invalid/worker.ts"), 5);
} catch (error) {
  console.log("rejected", (error as { code?: string }).code);
}
