import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the closure module decided never to throw. */
export const closureNeverThrow: readonly IrLibFn[] = [
  // scr_closure_adopt_identity writes two fields of the adapter.
  "closure.shareIdentity",
];
