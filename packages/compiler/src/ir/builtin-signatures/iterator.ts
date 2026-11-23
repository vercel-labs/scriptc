import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The iterator builtin call slots. */
export const iteratorSignatures = defineLibFnSignatures({
  /** %Iterator.prototype% and %Iterator% (scr_js_iterator.c), `new
   * Iterator()` (always the abstract-class TypeError), Iterator.from over
   * a checked value, and OrdinaryHasInstance(%Iterator%, value). */
  "iterator.prototype": { argTypes: [], result: DYN },
  "iterator.constructor": { argTypes: [], result: DYN },
  "iterator.construct": { argTypes: [], result: DYN },
  "iterator.from": { argTypes: [DYN], result: DYN },
  "iterator.instanceOf": { argTypes: [DYN], result: BOOL },
});
