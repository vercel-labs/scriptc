// parentPort's EventTarget side in a worker that never constructs a channel:
// onmessage receives the first message, and after it is cleared an
// addEventListener('message') listener receives the next one.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: unknown) => {
    console.log("main", message);
    if (message === "attr:one") worker.postMessage("two");
    else if (message === "listener:two") {
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      worker.postMessage(cyclic);
    }
  });
  worker.on("exit", (code: number) => console.log("exit", code));
  worker.postMessage("one");
} else {
  const port = parentPort!;
  port.onmessage = (event: MessageEvent) => {
    port.postMessage(`attr:${String(event.data)}`);
    port.onmessage = null;
    port.addEventListener("message", (next: Event) => {
      const data = (next as MessageEvent).data as { self?: unknown };
      if (typeof data === "object" && data !== null && "self" in data) {
        port.postMessage(`listener:cyclic:${data.self === data}`);
        port.close();
      } else {
        port.postMessage(`listener:${String(data)}`);
      }
    });
  };
}
