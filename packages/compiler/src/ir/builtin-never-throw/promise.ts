import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the promise module decided never to throw. */
export const promiseNeverThrow: readonly IrLibFn[] = [
  // scr_resolve_adopt queues a job; a promise resolved with itself is
  // rejected, not thrown.
  "promise.adopt",
  // scr_promise_all_settled subscribes a countdown reaction to each entry
  // and queues one job for the entries already settled; the builder runs
  // later, inside the combinator's settlement, never in this call.
  "promise.allSettledTuple",
  // scr_promise_is_rejected reads the promise's state.
  "promise.entryRejected",
  // scr_promise_reason_dyn boxes the stored reason (a number, a boolean, a
  // string, an error object or the checked-dynamic value itself); running
  // out of memory ends the process.
  "promise.entryReason",
];
