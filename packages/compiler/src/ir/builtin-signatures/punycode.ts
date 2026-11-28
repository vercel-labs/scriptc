import { arrayOf, BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The punycode builtin call slots. */
export const punycodeSignatures = defineLibFnSignatures({
  /** node:punycode (scr_url.c): punycode.js 2.1.0's string conversions;
   * decode/toUnicode (and, past 32-bit deltas, encode/toASCII) throw the
   * module's RangeErrors, ucs2Encode String.fromCodePoint's. warn marks the
   * module's first load (scr_async_dyn.c) and reports DEP0040 then unless
   * the second argument is false: at once for a static ES import, on the
   * next tick for a require() call. */
  "punycode.decode": { argTypes: [STRING], result: STRING },
  "punycode.encode": { argTypes: [STRING], result: STRING },
  "punycode.toASCII": { argTypes: [STRING], result: STRING },
  "punycode.toUnicode": { argTypes: [STRING], result: STRING },
  "punycode.ucs2Decode": { argTypes: [STRING], result: arrayOf(F64) },
  "punycode.ucs2Encode": { argTypes: [arrayOf(F64)], result: STRING },
  /** The module's ucs2 object as a value (scr_url.c): Node builds it once,
   * from a thunk over the two function values above. */
  "punycode.ucs2Object": { argTypes: [DYN], result: DYN },
  "punycode.warn": { argTypes: [BOOL, BOOL], result: VOID },
});
