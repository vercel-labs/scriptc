import { Worker, isMainThread, workerData } from "node:worker_threads";

// An unhandled rejection ends a worker with an 'error' event: an
// error-like reason as itself, any other reason as Node's
// UnhandledPromiseRejection Error quoting the reason.
const reasons = ["string", "number", "undefined", "null", "object", "array", "symbol", "bigint", "errorLike", "error"];

if (isMainThread) {
  let next = 0;
  const run = (): void => {
    const reason = reasons[next++];
    if (reason === undefined) return;
    const worker = new Worker(new URL(import.meta.url), { workerData: reason });
    worker.on("error", (e: any) => {
      const at = typeof e.message === "string" ? e.message.indexOf("The promise") : -1;
      const message = at < 0 ? e.message : e.message.slice(at);
      console.log(reason, e instanceof Error, e.name, e.code, message, JSON.stringify(e));
    });
    worker.on("exit", (code: number) => {
      console.log(" ", "exit", code);
      run();
    });
  };
  run();
} else {
  const values: Record<string, unknown> = {
    string: "rejected",
    number: 1.5,
    undefined: undefined,
    null: null,
    object: { a: 1 },
    array: [1, [2, 3]],
    symbol: Symbol("why"),
    bigint: 10n,
    errorLike: { stack: "custom stack", message: "like an error" },
    error: new RangeError("real error"),
  };
  void Promise.reject(values[workerData as string]);
}
