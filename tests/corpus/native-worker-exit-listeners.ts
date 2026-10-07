import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  for (const mode of ["nested", "throw", "natural"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), {workerData: mode});
      worker.on("message", (value: unknown) => console.log(mode, "message", value));
      worker.on("error", (error: Error) => console.log(mode, "error", error.message));
      worker.on("exit", (code: number) => { console.log(mode, "exit", code); resolve(); });
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
