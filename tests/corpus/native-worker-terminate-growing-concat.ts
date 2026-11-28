// worker.terminate() while a worker grows strings through the mixed
// self-append forms (string + number, string + template): the unwind runs
// once the binding owns the result the runtime returned, so every reference
// is released exactly once. Every iteration starts from a fresh 48 MiB text,
// so the append it feeds must copy, and the terminate lands inside that copy.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

function grow(): string {
  let text = "";
  for (let round = 0; ; round++) {
    text = "x".repeat(50331648);
    text += round;
    text += `${round}:`;
    if (round === 2) parentPort!.postMessage("ready");
  }
  return text;
}

if (isMainThread) {
  await new Promise<void>((resolve) => {
    const worker = new Worker(new URL(import.meta.url));
    worker.once("message", () => {
      void worker.terminate().then((code: number) => console.log("terminate", code));
    });
    worker.once("exit", (code: number) => {
      console.log("exit", code);
      resolve();
    });
  });
} else {
  grow();
  console.log("unexpected return");
}
