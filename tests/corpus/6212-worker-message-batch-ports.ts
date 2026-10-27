import { MessageChannel, Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// A MessageChannel message that a worker 'message' listener posts while
// more worker messages are queued arrives after those messages and before
// setImmediate callbacks, as in Node. The listener waits on a shared flag
// until the worker has posted the rest.
function waitFor(flag: Int32Array, index: number): void {
  while (Atomics.load(flag, index) === 0) Atomics.wait(flag, index, 0, 50);
}
function signal(flag: Int32Array, index: number): void {
  Atomics.store(flag, index, 1);
  Atomics.notify(flag, index);
}

if (isMainThread) {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(new URL(import.meta.url), { workerData: flag });
  const channel = new MessageChannel();
  const log: string[] = [];
  channel.port2.on("message", (m: unknown) => {
    log.push(`channel ${String(m)}`);
  });
  let count = 0;
  worker.on("message", (m: unknown) => {
    count++;
    log.push(`worker ${String(m)}`);
    if (count === 1) {
      signal(flag, 0);
      waitFor(flag, 1);
      channel.port1.postMessage("c1");
      setImmediate(() => {
        log.push("immediate");
        setImmediate(() => {
          log.push("second immediate");
          for (const line of log) console.log(line);
          channel.port1.close();
        });
      });
    }
  });
} else {
  const flag = workerData as Int32Array;
  parentPort!.postMessage("w1");
  waitFor(flag, 0);
  for (let i = 2; i <= 6; i++) parentPort!.postMessage(`w${i}`);
  signal(flag, 1);
}
