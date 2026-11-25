import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the text module decided never to throw. */
export const textNeverThrow: readonly IrLibFn[] = [
  // scr_text_encode_into_str writes the two counts of the typed encodeInto
  // into the slots the compiler allocated: the walk runs no program code, a
  // destination that is not a u8 byte view ends the process at the entry's
  // own check, and running out of memory ends it too. The call reports no
  // error the emitter could deliver.
  "text.encodeIntoStr",
];
