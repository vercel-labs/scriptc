// The bundled declarations type the promise a process rejection listener
// receives as Promise<unknown> (it is a promise, and its value is whatever
// the rejection carried), and export fs's shared StatOptions record beside
// StatSyncOptions. Node runs this program; the compiled form must print the
// same lines.
import type { StatOptions, StatSyncOptions } from "node:fs";
import { statSync } from "node:fs";

const plain: StatOptions = { bigint: false };
const sync: StatSyncOptions = { bigint: false, throwIfNoEntry: false };
console.log(statSync(process.execPath, plain)!.isFile());
console.log(statSync(process.execPath, sync)!.isFile());

process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
  console.log("unhandled", promise instanceof Promise, reason instanceof Error ? reason.message : String(reason));
  promise.catch(() => {});
});
process.on("rejectionHandled", (promise: Promise<unknown>) => {
  console.log("handled", promise instanceof Promise);
  promise.then(
    (value) => console.log("settled", value),
    () => console.log("rejected"),
  );
});
setTimeout(() => console.log("timer"), 10);
void Promise.reject(new Error("boom"));
