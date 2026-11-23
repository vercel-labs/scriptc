import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the timers module decided never to throw. */
export const timersNeverThrow: readonly IrLibFn[] = [
  // Timeout.close() and Immediate.prototype[Symbol.dispose]() clear the
  // timer the handle names: the loop's clear, or the mock's own entry
  // removal when the program mocks timers. Neither throws nor runs a
  // callback.
  "timers.close",
  "timers.immediateClose",
  // The same clears in their disposal spelling, whose result is undefined
  // rather than the handle.
  "timers.dispose",
  "timers.immediateDispose",
];
