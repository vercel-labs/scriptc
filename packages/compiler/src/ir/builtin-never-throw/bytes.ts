import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the bytes module decided never to throw. */
export const bytesNeverThrow: readonly IrLibFn[] = [
  // scr_bytes_item_dyn reads a byte view's element as a checked-dynamic
  // value: an index that is not one of the view's elements answers undefined,
  // the element read runs no program code, and the box allocation cannot
  // raise (running out of memory ends the process).
  "bytes.itemDyn",
];
