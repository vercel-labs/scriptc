// process.abort() is a process-wide operation, and Node refuses it in a
// worker instead of signalling every thread: the call throws a catchable
// TypeError (ERR_WORKER_UNSUPPORTED_OPERATION), and both the worker and
// the process keep running. The main thread only observes a clean exit.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const messages: string[] = [];
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => messages.push(message));
  worker.on("error", (error: Error) => messages.push(`worker error ${error.name}`));
  worker.on("exit", (code: number) => {
    console.log("worker exit", code);
    console.log("messages", messages.join("|"));
  });
  console.log("spawned");
} else {
  try {
    process.abort();
    parentPort!.postMessage("abort returned");
  } catch (error) {
    const refused = error as { name: string; code: string; message: string };
    parentPort!.postMessage(`caught ${refused.name} ${refused.code} ${refused.message}`);
  }
  parentPort!.postMessage("worker continues");
}
