import { BOOL, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The qs builtin call slots. */
export const qsSignatures = defineLibFnSignatures({
  // node:querystring. qs.parse's result is the call site's ParsedUrlQuery
  // dictionary record (VOID is the networkInterfaces sentinel — the
  // libCall case checks the structure); qs.stringify's object argument
  // is a dyn value (the frontend dynFroms typed records).
  /** node:querystring (scr_qs.c — link-gated by moduleUsesQs; NOT
   * URLSearchParams: the legacy codec's escaping and '+' rules differ).
   * qs.escape is Node's qsEscape, which encodes exactly the component
   * unreserved set — it emits the always-linked scr_qs_escape, so
   * escape-only programs never pull the unit. qs.unescape is Node's qsUnescape: strict decodeURIComponent
   * first, the lenient legacy unescapeBuffer fallback on failure (never
   * throws). qs.parse takes (str, sep, eq, maxKeys) — the frontend
   * completes omitted/null sep/eq to "&"/"=" and the omitted maxKeys
   * option to Node's 1000 (0 and negatives mean unlimited, Node's rule) —
   * and its result type is the CALL SITE's mapped ParsedUrlQuery shape (a
   * pure index-signature record over `string | string[]`, an undefined
   * arm tolerated — @types/node's Dict), verified structurally by the
   * frontend (lowerQuerystringParseCall); the emitters construct the
   * record and hand its overflow map to scr_qs_parse_into with the two
   * union tags. qs.stringify takes (obj, sep, eq) with obj a dyn value
   * (the frontend dynFroms the typed record; JS-world dyn values pass
   * through) — Node's encodeStringified rules run in the runtime, so
   * arrays expand to repeated keys and null/undefined/nested objects are
   * empty values. Custom encoder/decoder options fence at compile time.
   * All borrow; string results +1; escape and stringify throw URIError
   * [ERR_INVALID_URI] on a lone surrogate. */
  "qs.parse": { argTypes: [STRING, STRING, STRING, F64], result: VOID },
  /** parse with a decodeURIComponent option: qs, sep, eq, maxKeys and
   * the option's value (a function decodes; any other value means the
   * default decoder). The result is the same dictionary as qs.parse's. */
  "qs.parseCustom": { argTypes: [STRING, STRING, STRING, F64, DYN], result: VOID },
  "qs.stringify": { argTypes: [DYN, STRING, STRING], result: STRING },
  /** stringify with an encodeURIComponent option's value. */
  "qs.stringifyCustom": { argTypes: [DYN, STRING, STRING, DYN], result: STRING },
  /** A sep/eq argument that may not be a string: (value, default, parse). */
  "qs.separator": { argTypes: [DYN, STRING, BOOL], result: STRING },
  /** unescapeBuffer(s, decodeSpaces) as a new Buffer. */
  "qs.unescapeBuffer": { argTypes: [STRING, BOOL], result: BYTES_U8 },
  "qs.escape": { argTypes: [STRING], result: STRING },
  /** escape of a value that may not be a string: String(value) for an
   * object or null, value + "" otherwise (a symbol throws TypeError). */
  "qs.escapeValue": { argTypes: [DYN], result: STRING },
  "qs.unescape": { argTypes: [STRING], result: STRING },
});
