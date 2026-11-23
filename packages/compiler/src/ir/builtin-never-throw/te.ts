import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the te module decided never to throw. */
export const teNeverThrow: readonly IrLibFn[] = [
  // scr_te_get_enabled_categories reads the registry's own strings.
  "te.getEnabledCategories",
];
