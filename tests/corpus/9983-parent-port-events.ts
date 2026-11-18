// parentPort's EventTarget side in a worker that never constructs a channel:
// onmessage receives the first message, and after it is cleared an
// addEventListener('message') listener receives the next one.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: unknown) => {
    console.log("main", message);
    if (message === "attr:one") worker.postMessage("two");
  });
  worker.on("exit", (code: number) => console.log("exit", code));
  worker.postMessage("one");
} else {
  const port = parentPort!;
  port.onmessage = (event: MessageEvent) => {
    port.postMessage(`attr:${String(event.data)}`);
    port.onmessage = null;
    port.addEventListener("message", (next: Event) => {
      port.postMessage(`listener:${String((next as MessageEvent).data)}`);
      port.close();
    });
  };
}
