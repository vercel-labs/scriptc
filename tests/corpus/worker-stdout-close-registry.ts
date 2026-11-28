// A worker that registers stdout 'close' listeners with captures and exits
// WITHOUT destroy(): thread cleanup must release the listener registry and
// its captures, so the sanitized lane's RC audit stays clean. The main
// thread only waits for the exit, so the output is deterministic.
import { Worker, isMainThread } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("exit", (code) => console.log("worker exit", code));
} else {
  const payload = "captured payload";
  process.stdout.on("close", () => {
    console.log(payload.length);
  });
  process.stdout.once("close", () => {
    console.log(payload.length);
  });
}
