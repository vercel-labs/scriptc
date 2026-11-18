// Two workers create their first primitive wrapper at the same moment: the
// table that answers "is this a wrapper" is installed by each thread, so the
// installation stores one process-wide pointer, and every thread stores the
// same address.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);
if (isMainThread) {
  const values = [];
  for (let i = 0; i < 2; i++) {
    const worker = new Worker(self);
    worker.on("message", (value) => {
      values.push(value);
      if (values.length === 2) console.log("wrappers made", values.sort().join(","));
    });
  }
} else {
  const boxed = new Number(41);
  parentPort.postMessage(boxed.valueOf() + 1);
}
