import { Worker, isMainThread, parentPort } from "node:worker_threads";

// worker.stdout and worker.stderr are Readables whether or not the Worker was
// constructed with the stdout/stderr options. Without the option the worker's
// writes reach the process's own output too, and the stream's chunks arrive in
// order with the worker's messages, as Node pipes them.
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const seen: string[] = [];
  console.log("has streams", worker.stdout !== null, worker.stderr !== null);
  worker.stdout.on("data", (chunk: unknown) => seen.push(`out:${String(chunk).trim()}`));
  worker.stderr.on("data", (chunk: unknown) => seen.push(`err:${String(chunk).trim()}`));
  worker.on("message", (value: unknown) => console.log("message", value));
  worker.on("exit", () => console.log("stream saw", seen.join("|")));
} else {
  console.log("first");
  console.error("warning");
  parentPort!.postMessage("ping");
}
