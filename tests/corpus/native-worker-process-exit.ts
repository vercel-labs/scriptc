import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (value: unknown) => console.log("message", value));
  worker.on("exit", (code: number) => console.log("exit", code, "parent alive"));
} else {
  process.on("exit", (code: number) => parentPort!.postMessage(code));
  process.exit(7);
  console.log("unreachable");
}
