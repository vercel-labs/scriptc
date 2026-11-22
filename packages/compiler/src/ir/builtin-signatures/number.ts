import { BOOL, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The number builtin call slots. */
export const numberSignatures = defineLibFnSignatures({
  /** The Number statics with a static C implementation (scr_lib.c): one
   * f64 arg → bool, JS-exact BY CONSTRUCTION — Number.isFinite/isNaN/
   * isInteger/isSafeInteger never coerce, and the frontend routes only
   * f64-typed arguments here (other static types fence). None throws. */
  "number.isFinite": { argTypes: [F64], result: BOOL },
  "number.isNaN": { argTypes: [F64], result: BOOL },
  "number.isInteger": { argTypes: [F64], result: BOOL },
  "number.isSafeInteger": { argTypes: [F64], result: BOOL },
});
