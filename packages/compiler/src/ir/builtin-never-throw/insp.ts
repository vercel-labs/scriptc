import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the insp module decided never to throw. */
export const inspNeverThrow: readonly IrLibFn[] = [
  // scr_insp_numeric_separator stores one flag and answers its previous
  // value.
  "insp.numericSeparator",
  // scr_insp_prop_child stores one flag; scr_insp_property builds a string.
  "insp.propChild",
  "insp.property",
];
