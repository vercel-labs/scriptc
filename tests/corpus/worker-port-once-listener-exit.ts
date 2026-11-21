// Listeners leave a parentPort without removeEventListener: a `{ once: true }`
// listener is removed when it fires, and an AbortSignal removes the listener
// registered with it. With none left the port must stop referencing the
// loop, so the worker exits on its own (no close() call).
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (value: number) => console.log("main got", value));
  worker.on("exit", (code: number) => {
    console.log("worker exit", code);
    process.exit(0);
  });
  worker.postMessage(1);
  setTimeout(() => {
    console.log("timeout");
    process.exit(1);
  }, 2000);
} else {
  const controller = new AbortController();
  parentPort!.addEventListener("message", () => controller.abort(), { once: true });
  parentPort!.addEventListener("message", () => console.log("never"), {
    signal: controller.signal,
  });
  parentPort!.postMessage(2);
}
