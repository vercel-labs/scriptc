import { Worker, isMainThread, parentPort, resourceLimits, workerData } from "node:worker_threads";

// resourceLimits is {} in the main thread and after a worker exits. A
// worker's resourceLimits.stackSizeMb sets its thread's stack size: deep
// recursion still ends in a catchable RangeError. A stackSizeMb of 0 keeps
// the default stack.
function depth(n: number, path: number[]): number {
  path.push(n);
  const result = n === 0 ? 0 : 1 + depth(n - 1, path);
  path.pop();
  return result;
}

if (isMainThread) {
  console.log("main", JSON.stringify(resourceLimits), Object.keys(resourceLimits).length);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: "small",
    resourceLimits: { stackSizeMb: 1 },
  });
  worker.on("message", (m: unknown) => console.log("small stack", JSON.stringify(m)));
  worker.on("exit", (code: number) => {
    console.log("exit", code, JSON.stringify(worker.resourceLimits));
    const other = new Worker(new URL(import.meta.url), {
      workerData: "default",
      resourceLimits: { stackSizeMb: 0 },
    });
    other.on("message", (m: unknown) => console.log("default stack", JSON.stringify(m)));
    other.on("exit", (c: number) => console.log("exit", c));
  });
} else {
  let overflow = "none";
  try {
    depth(1e7, []);
  } catch (error) {
    if (error instanceof RangeError) overflow = error.name;
  }
  parentPort!.postMessage({ data: workerData, overflow, shallow: depth(1000, []) });
}
