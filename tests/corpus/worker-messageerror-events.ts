// A Worker answers 'messageerror' as an ordinary emitter event: registering
// one returns the worker, is counted among its listeners, and leaves normal
// traffic and the 'message' listener untouched.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const listener = (event: any) => console.log("messageerror", event && event.type);
  const returned = worker.on("messageerror", listener);
  console.log("on returns worker", returned === worker, "count", worker.listenerCount("messageerror"));
  worker.on("message", (value: unknown) => console.log("message", JSON.stringify(value)));
  worker.postMessage({ ping: 1 });
} else {
  parentPort!.once("message", (value: unknown) => {
    parentPort!.postMessage({ pong: (value as { ping: number }).ping });
  });
}
