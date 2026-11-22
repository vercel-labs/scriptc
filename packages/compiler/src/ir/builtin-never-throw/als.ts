import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the als module decided never to throw. */
export const alsNeverThrow: readonly IrLibFn[] = [
  // scr_als_with_scope reads the effective store, enters the new one and
  // boxes the RunScope; no program code runs and nothing raises.
  "als.withScope",
];
