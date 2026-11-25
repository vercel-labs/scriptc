import { BOOL, BYTES_U8, DYN, SEARCH_PARAMS_T, STRING, URL_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The url builtin call slots. */
export const urlSignatures = defineLibFnSignatures({
  /** node:url + the URL class (scr_url.c). url.new parses one absolute
   * URL string into a mutable URL value (+1) — invalid input THROWS a
   * catchable TypeError ("Invalid URL"), like Node's constructor. The
   * getters (borrowed receiver, +1 string) never throw; url.href doubles
   * as toString(). fileURLToPath has one libFn per receiver form (URL
   * value / string) — both THROW Node's TypeErrors on non-file schemes,
   * encoded slashes, and non-empty hosts. url.pathToFileURL resolves the
   * path (getcwd) and never throws. */
  "url.new": { argTypes: [STRING], result: URL_T },
  "url.newBase": { argTypes: [STRING, STRING], result: URL_T },
  /** Factories consume already-converted input/base strings. canParse
   * answers a boolean; parse returns a checked native URL or null (+1).
   * Parser failures are suppressed; conversion occurs before these calls. */
  "url.canParse": { argTypes: [STRING], result: BOOL },
  "url.canParseBase": { argTypes: [STRING, STRING], result: BOOL },
  "url.parse": { argTypes: [STRING], result: DYN },
  "url.parseBase": { argTypes: [STRING, STRING], result: DYN },
  /** URL.createObjectURL(blob): the argument arrives as a checked
   * dynamic value and must be a Blob or File handle — any other value
   * THROWS Node's ERR_INVALID_ARG_TYPE naming `obj`. A registered blob
   * answers a fresh "blob:nodedata:<uuid v4>" id. */
  "url.createObjectURL": { argTypes: [DYN], result: STRING },
  /** URL.revokeObjectURL(id): the id arrives already converted. The
   * runtime parses it as a URL and drops the registration whose id is
   * the pathname text between its first and second colon, so a query or
   * fragment on the id still revokes it. Unparsable input, a pathname
   * with no colon or a second colon, and ids that were never registered
   * (or were revoked) miss. Never throws. */
  "url.revokeObjectURL": { argTypes: [STRING], result: VOID },
  "url.protocol": { argTypes: [URL_T], result: STRING },
  "url.origin": { argTypes: [URL_T], result: STRING },
  "url.username": { argTypes: [URL_T], result: STRING },
  "url.password": { argTypes: [URL_T], result: STRING },
  "url.host": { argTypes: [URL_T], result: STRING },
  "url.hostname": { argTypes: [URL_T], result: STRING },
  "url.port": { argTypes: [URL_T], result: STRING },
  "url.pathname": { argTypes: [URL_T], result: STRING },
  "url.href": { argTypes: [URL_T], result: STRING },
  /** Selected component writes borrow the receiver and converted string.
   * href replaces its parsed fields while retaining cached params identity. */
  "url.set": { argTypes: [URL_T, STRING, STRING], result: VOID },
  "url.setChecked": { argTypes: [URL_T, STRING, DYN], result: VOID },
  "url.fileURLToPathUrl": { argTypes: [URL_T], result: STRING },
  /** fileURLToPathUrl as a value: the path string, or the error it would
   * throw (fs.existsSync and fs.promises URL paths). Never throws. */
  "url.fileURLToPathValue": { argTypes: [URL_T], result: DYN },
  "url.fileURLToPathChecked": { argTypes: [DYN], result: STRING },
  "url.fileURLToPathOptions": { argTypes: [DYN, DYN], result: STRING },
  /** node:url's legacy API (scr_url_legacy.c): parse(url, parseQueryString,
   * slashesDenoteHost) answers the checked-dynamic Url instance; format
   * takes the urlObject (a Url-shaped object, a string, or a URL) and the
   * URL form's options; resolve takes (from, to). The trailing bool says
   * whether the call site emits DEP0169. domainToASCII/domainToUnicode
   * take the domain and whether it was omitted. Node's validation errors
   * throw catchably. */
  /** url.Url as a value: Node's legacy Url constructor, the class of
   * url.parse() results. One identity per thread. */
  "url.legacyClass": { argTypes: [], result: DYN },
  "url.legacyParse": { argTypes: [DYN, DYN, DYN, BOOL], result: DYN },
  "url.legacyFormat": { argTypes: [DYN, DYN, BOOL], result: STRING },
  "url.legacyResolve": { argTypes: [DYN, DYN, BOOL], result: STRING },
  "url.domainToASCII": { argTypes: [DYN, BOOL], result: STRING },
  "url.domainToUnicode": { argTypes: [DYN, BOOL], result: STRING },
  /** url.urlToHttpOptions over a checked-dynamic argument: a URL answers
   * Node's null-prototype options object; a primitive or null throws
   * ERR_INVALID_ARG_TYPE. */
  "url.toHttpOptions": { argTypes: [DYN], result: DYN },
  "url.fileURLToPathBuffer": { argTypes: [DYN, DYN], result: BYTES_U8 },
  "url.pathToFileURLChecked": { argTypes: [DYN, DYN], result: URL_T },
  "url.fileURLToPathStr": { argTypes: [STRING], result: STRING },
  "url.pathToFileURL": { argTypes: [STRING], result: URL_T },
  /** Explicit path syntax from the options.windows argument, independent
   * of the executable's host platform. Windows UNC input can throw. */
  "url.pathToFileURLPlatform": { argTypes: [STRING, BOOL], result: URL_T },
  /** pathToFileURL under a win32 TARGET: the same scr_url_from_path call
   * (the runtime selects the win32 arm by _WIN32), but a distinct IR name
   * because that arm THROWS for malformed UNC inputs — may-throw seeds on
   * it while posix pathToFileURL emission stays byte-identical. */
  "url.pathToFileURLWin32": { argTypes: [STRING], result: URL_T },
  "url.searchParams": { argTypes: [URL_T], result: SEARCH_PARAMS_T },
  "url.search": { argTypes: [URL_T], result: STRING },
  "url.hash": { argTypes: [URL_T], result: STRING },
});
