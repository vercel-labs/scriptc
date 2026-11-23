import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the global module decided never to throw. */
export const globalNeverThrow: readonly IrLibFn[] = [
  "global.bindingValue",
  // scr_global_binding_has looks the name up in the same table.
  "global.bindingHas",
];
