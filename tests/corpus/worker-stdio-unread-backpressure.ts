import { Worker, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);

// A worker that logs without the stdout option: its writes go to the process's
// own output, and worker.stdout carries nothing left over. A parent that never
// reads the stream must not accumulate its chunks.
if (isMainThread) {
  const worker = new Worker(self);
  worker.on("exit", () => {
    console.log("left in the stream", worker.stdout.readableLength > 0);
  });
} else {
  for (let i = 0; i < 200; i++) console.log("line", i);
}
