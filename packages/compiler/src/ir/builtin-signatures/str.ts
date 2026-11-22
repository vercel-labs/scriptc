import { arrayOf, BOOL, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The str builtin call slots. */
export const strSignatures = defineLibFnSignatures({
  /** `a.localeCompare(b)`: -1/0/1 in Node's root-locale collation for
   * Latin-script text (scr_str_locale_compare). Never throws. */
  "str.localeCompare": { argTypes: [STRING, STRING], result: F64 },
  /** Annex B substr(start, length) with start ToNumber'd and length's
   * presence; never throws. */
  "str.substr": { argTypes: [STRING, F64, F64, BOOL], result: STRING },
  /** toLocaleLowerCase/toLocaleUpperCase (scr_regex.c): the locales value
   * as written, upper=true for toLocaleUpperCase. Throws for null and for
   * locale forms with no native rules. */
  "str.localeCase": { argTypes: [STRING, DYN, BOOL], result: STRING },
  "str.replaceLiteral": { argTypes: [STRING, STRING, STRING, BOOL], result: STRING },
  // (subject, characters, NUL-separated replacement texts): the fused
  // chain of global one-character replacements.
  "str.replaceChars": { argTypes: [STRING, STRING, STRING], result: STRING },
  "str.codePoints": { argTypes: [STRING], result: arrayOf(STRING) },
  /** The static URI component codecs (scr_string.c), ECMA-262 Encode/
   * Decode with the component sets over the runtime's UTF-8 strings.
   * str.encodeUriComponent percent-encodes every byte outside the
   * unreserved component set (ALPHA/DIGIT/- _ . ! ~ * ' ( )) as uppercase
   * %XX — the spec's per-code-point UTF-8 encoding IS a byte scan here —
   * and THROWS the spec's URIError ("URI malformed") on a lone surrogate.
   * str.decodeUriComponent
   * decodes %XX escapes bytewise (raw non-escape bytes copy through) and
   * requires the escaped bytes to form strictly valid UTF-8 (overlong
   * forms, surrogate code points, and >U+10FFFF refused, per UTF8-decode
   * without replacement); bad hex or an invalid sequence THROWS the
   * spec's URIError ("URI malformed"), catchable. Borrow; results +1. */
  "str.encodeUriComponent": { argTypes: [STRING], result: STRING },
  // The base64 globals: the argument is a dyn value (WebIDL ToString
  // runs in the runtime); the zero-argument form always throws.
  /** The WHATWG base64 globals (scr_string.c), Node-global since v16.
   * Arguments are borrowed dyn values — WebIDL ToString runs in the
   * runtime over the dyn kind (String(null) is "null": the html spec's
   * coercion, which Node's atob(null) exercises). str.atob decodes
   * forgiving-base64 (ASCII whitespace stripped, %4==0 strips up to two
   * '=', %4==1 refuses, leftover bits discarded) into the latin1 code
   * points as a string; a malformed input THROWS the catchable
   * DOMException InvalidCharacterError ("The string to be decoded is not
   * correctly encoded."). str.btoa encodes the string's code points as
   * base64; any code point over U+00FF THROWS InvalidCharacterError
   * ("Invalid character"). str.b64Missing is the zero-argument call of
   * either: always throws Node's TypeError [ERR_MISSING_ARGS] "The
   * \"input\" argument must be specified". Results +1. */
  "str.atob": { argTypes: [DYN], result: STRING },
  "str.btoa": { argTypes: [DYN], result: STRING },
  "str.b64Missing": { argTypes: [], result: STRING },
  "str.decodeUriComponent": { argTypes: [STRING], result: STRING },
  "str.decodeUri": { argTypes: [STRING], result: STRING },
  /** encodeURI: the same Encode() keeping the reserved set and '#'
   * unescaped — throwing like the component encoder. Borrow; result +1. */
  "str.encodeUri": { argTypes: [STRING], result: STRING },
});
