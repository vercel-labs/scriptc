// The project's tsconfig lists "webworker" in "lib": the names only that
// library declares type-check, and at run time they are absent, as under Node.
console.log(typeof importScripts, typeof WorkerGlobalScope, typeof self);

const scope: DedicatedWorkerGlobalScope | null = null;
console.log(scope === null);

function report(total: number): string {
  if (typeof self === "undefined" || typeof importScripts === "undefined") return `main:${total}`;
  self.postMessage(total);
  return "worker";
}
console.log(report(41 + 1));

try {
  importScripts("./helper.js");
  console.log("imported");
} catch (error) {
  console.log((error as Error).name + ": " + (error as Error).message);
}
