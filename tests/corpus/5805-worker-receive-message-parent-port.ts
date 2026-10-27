import { Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";

// receiveMessageOnPort(parentPort) in a worker takes the parent's messages
// one at a time, before and between 'message' listener deliveries, and
// answers undefined once the queue is empty. The worker starts reading
// once the parent has posted its first three messages (flag[1]), so the
// second read does not depend on thread timing.
if (isMainThread) {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(new URL(import.meta.url), { workerData: flag });
  worker.postMessage("a");
  worker.postMessage({ b: 2 });
  worker.postMessage("c");
  Atomics.store(flag, 1, 1);
  Atomics.notify(flag, 1);
  worker.on("message", (m: unknown) => {
    console.log("main got", JSON.stringify(m));
    if (m === "ready") {
      worker.postMessage("d");
      worker.postMessage("e");
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    }
  });
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  const flag = workerData as Int32Array;
  const port = parentPort!;
  Atomics.wait(flag, 1, 0);
  let first = receiveMessageOnPort(port);
  while (first === undefined) first = receiveMessageOnPort(port);
  port.postMessage(["first", first]);
  port.postMessage(["second", receiveMessageOnPort(port)]);
  port.on("message", (v: unknown) => {
    port.postMessage(["listener", v]);
    if (v === "c") {
      port.postMessage("ready");
      Atomics.wait(flag, 0, 0);
      let next = receiveMessageOnPort(port);
      while (next === undefined) next = receiveMessageOnPort(port);
      port.postMessage(["sync", next]);
    }
    if (v === "e") {
      port.postMessage(["empty", receiveMessageOnPort(port) === undefined]);
      port.close();
    }
  });
}
