// A worker that is terminated while it calls a typed function through an
// untyped value. The call converts its string argument for the function's
// declared parameter and tests for a pending exception after the conversion
// and again after the call; in a worker both tests also answer true once the
// terminate request has arrived, although the conversion and the call
// succeeded. The call thunk then gives up and must release the argument it
// converted and the result the function returned: otherwise each terminated
// worker leaves one string behind (the sanitized lane's reference-count
// audit reports it at exit).
import { Worker, isMainThread, parentPort } from "node:worker_threads";

function pick(values: unknown[], index: number): any {
  return values[index % values.length];
}

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", async () => {
    console.log("ready");
    console.log("terminated", await worker.terminate());
  });
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  const label = (text: string): string => text + "!";
  const call = pick([label], 0);
  parentPort!.postMessage("ready");
  let turn = 0;
  while (true) {
    turn = (turn + 1) % 1000;
    call("turn " + turn);
  }
}
