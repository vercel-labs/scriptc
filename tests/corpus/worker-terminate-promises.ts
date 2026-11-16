import { Worker, isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);

// terminate() answers a fresh promise per call, and each resolves with the
// worker's exit code. (After the exit event Node answers undefined there;
// scriptc answers the exit code, which Promise<number> can spell. The corpus
// therefore checks only that a late call answers a promise.)
if (isMainThread) {
  const worker = new Worker(self);
  worker.on("online", async () => {
    const first = worker.terminate();
    const second = worker.terminate();
    console.log("distinct promises", first !== second);
    const codes = [await first, await second];
    console.log("codes", codes.join(","));
  });
  worker.on("exit", (code) => {
    console.log("exit", code);
    const late = worker.terminate();
    console.log("late is a promise", late instanceof Promise);
    late.catch(() => {});
  });
} else {
  setInterval(() => {}, 1000);
}
