// crypto.setFips is not available in a worker: Node throws
// ERR_WORKER_UNSUPPORTED_OPERATION there, and getFips keeps reading the
// process-wide flag (the worker reads it, the main context writes it).
import { getFips, setFips } from "node:crypto";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  console.log("main", getFips());
  const report = await new Promise<string>((resolve, reject) => {
    let text = "";
    const worker = new Worker(new URL(import.meta.url));
    worker.once("message", (value: unknown) => {
      text = value as string;
    });
    worker.once("error", reject);
    worker.once("exit", () => resolve(text));
  });
  console.log("worker", report);
  setFips(false);
  console.log("main after", getFips());
} else {
  const before = getFips();
  let thrown = "none";
  try {
    setFips(false);
  } catch (error) {
    const typed = error as Error & { code?: string };
    thrown = `${typed.name} ${typed.code} | ${typed.message}`;
  }
  parentPort!.postMessage(`${before} | ${thrown} | ${getFips()}`);
}
