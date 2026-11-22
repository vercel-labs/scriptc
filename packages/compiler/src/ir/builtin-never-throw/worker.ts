import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the worker module decided never to throw. */
export const workerNeverThrow: readonly IrLibFn[] = [
  // scr_worker_share_env answers the thread's SHARE_ENV symbol and makes it
  // on first use; it takes no argument, and running out of memory ends the
  // process.
  "worker.shareEnv",
  // scr_worker_performance answers the Worker's { eventLoopUtilization }
  // object, made once per Worker; a handle of another class reads undefined,
  // and running out of memory ends the process.
  "worker.performance",
];
