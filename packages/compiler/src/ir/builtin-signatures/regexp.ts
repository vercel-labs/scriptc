import { STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The regexp builtin call slots. */
export const regexpSignatures = defineLibFnSignatures({
  /** RegExp.escape (ES2025): per-code-point EncodeForRegExpEscape —
   * leading ASCII alphanumeric hex-escapes, syntax characters and '/'
   * take a backslash, other punctuators/whitespace/line terminators
   * hex-escape, the rest passes through. Total; borrows; result +1. */
  "regexp.escape": { argTypes: [STRING], result: STRING },
});
