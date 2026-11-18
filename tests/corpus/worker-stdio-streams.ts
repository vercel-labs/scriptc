import { Worker, isMainThread, parentPort } from "node:worker_threads";

// worker.stdout and worker.stderr are Readables whether or not the Worker was
// constructed with the stdout/stderr options. Without the option the worker's
// writes reach the process's own output too, and the stream's chunks arrive in
// order with the worker's messages, as Node pipes them. A listener added later
// runs after the chunk has been forwarded, as Node's pipe is registered first.
// The message is printed with the streams' tally at exit: the message port and
// the stdio pipe are separate queues, so which arrives first is a scheduling
// choice Node does not fix.
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const seen: string[] = [];
  const messages: string[] = [];
  console.log("has streams", worker.stdout !== null, worker.stderr !== null);
  worker.stdout.on("data", (chunk: unknown) => seen.push(`out:${String(chunk).trim()}`));
  worker.stderr.on("data", (chunk: unknown) => seen.push(`err:${String(chunk).trim()}`));
  worker.stdout.on("data", (chunk: unknown) => console.log("listener saw", String(chunk).trim()));
  worker.on("message", (value: unknown) => messages.push(String(value)));
  worker.on("exit", () =>
    console.log("stream saw", seen.join("|"), "message saw", messages.join("|")),
  );
} else {
  console.log("first");
  console.error("warning");
  parentPort!.postMessage("ping");
}
