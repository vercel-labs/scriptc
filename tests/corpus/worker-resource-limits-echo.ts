import { Worker, isMainThread, parentPort, resourceLimits } from "node:worker_threads";

// worker.resourceLimits answers the limits the constructor asked for while
// the worker runs, and {} once it stopped. Node reports -1 for an unset
// limit, keeps a non-positive stack size at the 4 MB default, and ignores a
// field that is not a number. A heap limit is not requested here: a compiled
// program has one heap for every thread, so requesting one is refused (the
// build's diagnostic and the runtime's error name that refusal).
//
// Only the stack is read from a running worker: Node fills the unset heap
// fields from the worker's own isolate once that isolate exists, so reading
// them immediately after the constructor races the worker's start and
// answers either the requested -1 or the machine's V8 heap configuration.
// The stack is the requested one (or the 4 MB default) before and after the
// start, and the whole object answers after the exit below. It is read
// through the object's checked-dynamic view: the static lowering answers the
// whole ResourceLimits object, not a typed member of it.
if (isMainThread) {
  const stackOf = (worker: Worker): number => {
    const limits: any = worker.resourceLimits;
    return limits.stackSizeMb;
  };
  const plain = new Worker(new URL(import.meta.url));
  console.log("plain", stackOf(plain), Object.keys(plain.resourceLimits!).join(","));
  plain.on("message", (message: string) => console.log("inner", message));

  const limits = new Worker(new URL(import.meta.url), { resourceLimits: { stackSizeMb: 2 } });
  console.log("limits stack", stackOf(limits));

  const zero = new Worker(new URL(import.meta.url), { resourceLimits: { stackSizeMb: 0 } });
  console.log("zero stack", stackOf(zero));

  const fractional = new Worker(new URL(import.meta.url), { resourceLimits: { stackSizeMb: 1.5 } });
  console.log("fractional stack", stackOf(fractional));

  const ignored = new Worker(new URL(import.meta.url), {
    resourceLimits: { stackSizeMb: "2" } as any,
  });
  console.log("non-number stack", stackOf(ignored));

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
