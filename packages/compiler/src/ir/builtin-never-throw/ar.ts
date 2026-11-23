import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the ar module decided never to throw. */
export const arNeverThrow: readonly IrLibFn[] = [
  // The AsyncResource reads answer the registry's ids, and emitDestroy
  // marks the entry; none runs program code or raises.
  "ar.asyncId",
  "ar.emitDestroy",
  "ar.triggerAsyncId",
];
