import { arrayOf, BOOL, DYN, F64, REGEX, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The regex builtin call slots. */
export const regexSignatures = defineLibFnSignatures({
  /** `new RegExp(pattern, flags?)` (scr_regex.c): a heap regex over the
   * same libregexp engine the literals use. The pattern compiles EAGERLY
   * so an invalid pattern (or an unknown flag letter) throws Node's
   * catchable SyntaxError at construction — Node's message shape with
   * libregexp's detail text (approximate fidelity; e.name exact). An
   * empty pattern stores the spec's "(?:)" source. Both args borrowed
   * strings (the lowering completes an absent flags to ""); result +1.
   * The result TYPE is the regex kind, so the link switch pulls the
   * engine exactly like a literal. */
  "regex.new": { argTypes: [STRING, STRING], result: REGEX },
  "regex.resetLastIndex": { argTypes: [REGEX, F64], result: VOID },
  "regex.newChecked": { argTypes: [DYN, DYN], result: REGEX },
  "regex.callChecked": { argTypes: [DYN, DYN], result: REGEX },
  "regex.replaceCallback": { argTypes: [STRING, REGEX, DYN, BOOL], result: STRING },
  // Reads of capture args[1] of an execSpans/matchGroups result:
  // `capture === args[2]`, Number(capture) and parseInt(capture,
  // args[2]). Borrowed; never throw.
  "regex.groupEquals": { argTypes: [arrayOf(STRING), F64, STRING], result: BOOL },
  "regex.groupNumber": { argTypes: [arrayOf(STRING), F64], result: F64 },
  "regex.groupParseInt": { argTypes: [arrayOf(STRING), F64, F64], result: F64 },
  // `.index` / `.input` (args[1]) of a match result. Borrowed; never throws.
  "regex.resultProp": { argTypes: [arrayOf(STRING), STRING], result: DYN },
});
