import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the abort module decided never to throw. */
export const abortNeverThrow: readonly IrLibFn[] = ["abort.signalIs"];
