import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  for (const mode of ["nested", "throw", "natural"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), {workerData: mode});
      let message = -1;
      let messages = 0;
      let failure = "none";
      // Message and error use independent channels; both must arrive before exit.
      worker.on("message", (value: number) => { message = value; messages++; });
      worker.on("error", (error: Error) => { failure = error.message; });
      worker.on("exit", (code: number) => {
        console.log(mode, "exit", code, "messages", messages, message, "error", failure);
        resolve();
      });
    });
  }
} else {
  process.on("exit", (code: number) => {
    parentPort!.postMessage(code);
    if (workerData === "nested") process.exit(3);
    if (workerData === "throw") throw new Error("exit listener failed");
  });
  if (workerData !== "natural") process.exit(7);
}
