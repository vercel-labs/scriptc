import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the weakMap module decided never to throw. */
export const weakMapNeverThrow: readonly IrLibFn[] = [
  // scr_dyn_new_promise retains the promise and allocates its box.
  "weakMap.promiseKey",
];
