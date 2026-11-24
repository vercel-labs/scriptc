import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the weakRef module decided never to throw. */
export const weakRefNeverThrow: readonly IrLibFn[] = [
  // scr_weak_ref_is and scr_dyn_abort_signal_is compare the value's kind
  // and handle tag.
  "weakRef.is",
];
