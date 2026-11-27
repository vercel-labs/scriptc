// MessagePort.postMessage answers true on an open port; a closed port and a
// Worker answer undefined, as in Node.
import { MessageChannel, Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const open = new MessageChannel();
  console.log("open", JSON.stringify(open.port1.postMessage("a")));
  const closed = new MessageChannel();
  closed.port1.close();
  console.log("closed", JSON.stringify(closed.port1.postMessage("b")));
  const worker = new Worker(new URL(import.meta.url));
  console.log("worker", JSON.stringify(worker.postMessage("c")));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await worker.terminate();
  open.port1.close();
  open.port2.close();
  closed.port2.close();
} else {
  parentPort.on("message", () => {});
}
