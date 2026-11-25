// A worker thread constructs a URLPattern: the handle registry is
// thread-local, so the worker's own context must have installed the
// URLPattern ops before the first construction.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (value: string) => console.log("worker", value));
  worker.on("error", (error: Error) => console.log("worker error", error.name, error.message));
} else {
  const pattern = new URLPattern("https://example.com/books/:id");
  const hit = pattern.test("https://example.com/books/42");
  const miss = pattern.test("https://example.com/other/42");
  parentPort!.postMessage(JSON.stringify([hit, miss, pattern.hostname, pattern.pathname]));
}
