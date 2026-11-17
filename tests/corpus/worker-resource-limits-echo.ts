import { Worker, isMainThread, parentPort, resourceLimits } from "node:worker_threads";

// worker.resourceLimits answers the limits the constructor asked for while
// the worker runs, and {} once it stopped. Node reports -1 for an unset
// limit, keeps a non-positive stack size at the 4 MB default, and ignores a
// field that is not a number. A heap limit is not requested here: a compiled
// program has one heap for every thread, so requesting one is refused (the
// build's diagnostic and the runtime's error name that refusal).
if (isMainThread) {
  const plain = new Worker(new URL(import.meta.url));
  console.log("plain", JSON.stringify(plain.resourceLimits), Object.keys(plain.resourceLimits!).join(","));
  plain.on("message", (message: string) => console.log("inner", message));

  const limits = new Worker(new URL(import.meta.url), { resourceLimits: { stackSizeMb: 2 } });
  console.log("limits", JSON.stringify(limits.resourceLimits));

  const zero = new Worker(new URL(import.meta.url), { resourceLimits: { stackSizeMb: 0 } });
  console.log("zero stack", JSON.stringify(zero.resourceLimits));

  const fractional = new Worker(new URL(import.meta.url), { resourceLimits: { stackSizeMb: 1.5 } });
  console.log("fractional", JSON.stringify(fractional.resourceLimits));

  const ignored = new Worker(new URL(import.meta.url), {
    resourceLimits: { stackSizeMb: "2" } as any,
  });
  console.log("non-number", JSON.stringify(ignored.resourceLimits));

  plain.on("exit", () => {
    console.log("after exit", JSON.stringify(plain.resourceLimits));
    limits.terminate();
    zero.terminate();
    fractional.terminate();
    ignored.terminate();
  });
} else {
  // the limits a Worker reports to its own thread carry the same four keys,
  // though Node fills them from its isolate's heap configuration
  const values = Object.keys(resourceLimits).map((key) => (resourceLimits as any)[key]);
  parentPort!.postMessage(`${Object.keys(resourceLimits).join(",")} numbers=${values.every((v) => typeof v === "number")}`);
}
