import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the nodeIsland module decided never to throw. */
export const nodeIslandNeverThrow: readonly IrLibFn[] = [
  // scr_ni_intrinsic_register stores the value in a table.
  "nodeIsland.intrinsic",
];
