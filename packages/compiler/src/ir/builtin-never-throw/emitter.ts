import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the emitter module decided never to throw. */
export const emitterNeverThrow: readonly IrLibFn[] = [
  // scr_emitter_symbol_name allocates the registry key of the symbol it is
  // given (scr_str_symbol_key); running out of memory ends the process.
  "emitter.symName",
];
