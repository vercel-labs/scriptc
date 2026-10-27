// Message round trips between the main thread and one worker: the main
// thread posts a number and the worker answers it plus one, the given
// number of times. Each round trip is two messages and two wakeups of a
// waiting thread. Argument: the number of round trips.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const rounds = Number(process.argv[2] ?? "100000");
  const worker = new Worker(new URL(import.meta.url));
  let sent = 0;
  let sum = 0;
  worker.on("message", (value: number) => {
    sum += value;
    if (++sent === rounds) {
      console.log(`${rounds} round trips, sum ${sum}`);
      void worker.terminate();
    } else worker.postMessage(sent);
  });
  worker.postMessage(0);
} else {
  parentPort!.on("message", (value: number) => {
    parentPort!.postMessage(value + 1);
  });
}
