import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the sourceMap module decided never to throw. */
export const sourceMapNeverThrow: readonly IrLibFn[] = [
  // instanceof a SourceMap compares the handle's tag and allocates nothing.
  "sourceMap.is",
];
