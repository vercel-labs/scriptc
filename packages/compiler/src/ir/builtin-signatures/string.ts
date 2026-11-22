import { arrayOf, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The string builtin call slots. */
export const stringSignatures = defineLibFnSignatures({
  // Arg 0 is a packed f64[] OR a bytes value (the spread-typed-array
  // form) — checked in the libCall case.
  /** fromCharCode takes one packed f64[] or bytes arg and builds a string
   * from UTF-16 code units. Adjacent surrogate pairs combine; lone
   * surrogates follow the runtime's replacement policy. */
  "string.fromCharCode": { argTypes: [null], result: STRING },
  /** Numeric code points, with catchable RangeError for non-integers or
   * values outside 0..0x10ffff. Uses the same UTF-8 surrogate policy. */
  "string.fromCodePoint": { argTypes: [null], result: STRING },
  /** lastIndexOf returns the last UTF-16 start index, or -1. The two-arg
   * form searches at or before its numeric position; NaN starts at the end.
   * String arguments are borrowed and neither form throws. */
  "string.lastIndexOf": { argTypes: [STRING, STRING], result: F64 },
  "string.lastIndexOfFrom": { argTypes: [STRING, STRING, F64], result: F64 },
  /** String.raw(template, ...subs): the raw literals array (a string[]
   * read off the template record) interleaved with the PRE-STRINGIFIED
   * substitutions (the frontend applies the static ToString and packs
   * them into one string[] literal) — extra substitutions drop, missing
   * ones skip, the spec's loop exactly (scr_array.c). Borrowed args;
   * +1 string; never throws. */
  "string.raw": { argTypes: [arrayOf(STRING), arrayOf(STRING)], result: STRING },
});
