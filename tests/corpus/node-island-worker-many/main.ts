// @requires-libnode
// Four worker threads and the main thread use one Node island package at
// the same time: each worker makes island objects, reads them, passes them
// back and takes strings out in a loop, while the main thread does the same
// from a timer. A worker's operations are served on the island's thread, so
// every answer must be the one Node gives, whichever thread asked.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { describe, make, tally } from "calc-pkg";

if (isMainThread) {
  const workers = 4;
  const answers: string[] = [];
  let done = 0;
  let mainCalls = 0;
  let mainLength = 0;
  const timer = setInterval(() => {
    for (let i = 0; i < 40; i++) {
      mainLength += tally(i, mainCalls).length + describe(make(i)).length;
      mainCalls++;
    }
  }, 1);
  for (let w = 0; w < workers; w++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: w });
    worker.on("message", (message: string) => {
      answers[w] = message;
    });
    worker.on("exit", (code: number) => {
      if (code !== 0) console.log("worker", w, "exit", code);
      if (++done < workers) return;
      clearInterval(timer);
      for (const answer of answers) console.log(answer);
      console.log("main", mainCalls > 0, mainLength > 0, describe(make(41)));
    });
  }
} else {
  const id = workerData as number;
  let sum = 0;
  let length = 0;
  for (let i = 0; i < 1500; i++) {
    const item = make(i + id);
    sum += item.value;
    length += describe(item).length + item.label.length + tally(i, id).length;
  }
  parentPort!.postMessage(`worker ${id} ${sum} ${length}`);
}
