import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the sea module decided never to throw. */
export const seaNeverThrow: readonly IrLibFn[] = [
  // Emitted as the constant false; there is no runtime call.
  "sea.isSea",
];
