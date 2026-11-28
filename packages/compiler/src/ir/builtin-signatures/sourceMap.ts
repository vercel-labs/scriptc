import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sourceMap builtin call slots. */
export const sourceMapSignatures = defineLibFnSignatures({
  /** node:module's SourceMap class (scr_source_map.c): the constructor
   * validates and copies the payload, and instanceof compares handles. */
  "sourceMap.new": { argTypes: [DYN, DYN], result: DYN },
  "sourceMap.is": { argTypes: [DYN], result: BOOL },
});
