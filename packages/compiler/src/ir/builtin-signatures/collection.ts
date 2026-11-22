import { BOOL, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The collection builtin call slots. */
export const collectionSignatures = defineLibFnSignatures({
  /** Object.freeze, seal or preventExtensions of a Map or Set
   * (scr_map_prevent_extensions), which only makes it not extensible: its
   * entries stay writable. The receiver is any map or set type. */
  "collection.preventExtensions": { argTypes: [null], result: VOID },
  "collection.isExtensible": { argTypes: [null], result: BOOL },
});
