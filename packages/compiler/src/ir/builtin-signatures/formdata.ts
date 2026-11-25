import { BOOL, DYN, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The FormData builtin call slots (scr_formdata.c). */
export const formdataSignatures = defineLibFnSignatures({
  /** `new FormData()`: the constructor takes no arguments; a FormData
   * handle. */
  "formdata.new": { argTypes: [], result: DYN },
  /** The FormData class value Node's global names. */
  "formdata.class": { argTypes: [], result: DYN },
  /** `value instanceof FormData`. */
  "formdata.is": { argTypes: [DYN, F64], result: BOOL },
});
