import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the mkdtempResult module decided never to throw. */
export const mkdtempResultNeverThrow: readonly IrLibFn[] = [
  // DisposableTempDir.path hands the created path's reference on; nothing
  // runs.
  "mkdtempResult.path",
];
