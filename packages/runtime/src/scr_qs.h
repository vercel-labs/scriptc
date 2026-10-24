/* scriptc runtime — node:querystring (scr_qs.c), the node:util helpers
 * (scr_util.c), URI and base64 codecs. Included by scr_runtime.h, which says
 * where new declarations go. */
#ifndef SCR_QS_H
#define SCR_QS_H

#include "scr_string_methods.h"

/* ── node:querystring (scr_qs.c — LINK-GATED by moduleUsesQs; the
 * scr_url_params.c precedent: pure data transforms, no loop hooks).
 * querystring.escape needs no entry here: Node's qsEscape encodes exactly
 * the component unreserved set, so the frontend lowers it to
 * scr_qs_escape beside the component encoder (always linked; a program
 * using only escape never pulls this unit). */

/* querystring.unescape — Node's qsUnescape: strict decodeURIComponent
 * first, and on failure the lenient legacy unescapeBuffer(s).toString()
 * (valid %XX escapes decode to their byte, malformed escapes copy
 * literally, every non-escape UTF-16 CODE UNIT truncates to its low byte
 * — Node's Buffer element write — and the byte buffer decodes as UTF-8
 * with U+FFFD replacement per maximal subpart, Buffer.toString's rule).
 * Borrows s; result +1; never throws. */
ScrStr *scr_qs_unescape(const ScrStr *s);

/* querystring.parse — Node v24's scan state machine, byte-wise over the
 * UTF-8 storage (equivalent to the code-unit scan for well-formed input:
 * the machine compares sep/eq sequences positionally and treats '%'/'+'/
 * hex as ASCII, and multibyte alignment is preserved). Decoded pairs land
 * in `out` — the PURE-index-signature Dict record's overflow map (the
 * emitters pass rec->sc_ovf) — grouped like Node's addKeyVal: a first
 * value stores the `str_tag` union arm, a repeat REPLACES it with a
 * two-element string[] wrapped in `arr_tag`, later repeats push. sep/eq
 * fall back to "&"/"=" when empty (Node's falsy rule; the frontend
 * completes omitted/null arguments to the defaults). max_keys is Node's
 * rule exactly: > 0 caps the PAIR count (empty skipped segments count,
 * like Node's --pairs), anything else (0, negatives, NaN) is unlimited;
 * the frontend completes the omitted option to 1000. Only the DEFAULT
 * decoder runs (custom decodeURIComponent options fence at compile time),
 * so '+' means ' ' and segments decode with scr_qs_unescape's semantics
 * only when they carry a full valid %XX triple (Node's encodeCheck).
 * Borrows everything; never throws. */
typedef struct ScrMap ScrMap; /* full definition below (C11 repeat) */
void scr_qs_parse_into(ScrMap *out, const ScrStr *qs, const ScrStr *sep,
                       const ScrStr *eq, double max_keys, uint32_t str_tag,
                       uint32_t arr_tag);
/* querystring.parse(qs) with the default separators and maxKeys, as a
 * fresh checked-dynamic null-prototype object (url.parse's parsed query).
 * Borrows qs; +1; never throws. */
struct ScrDyn *scr_qs_parse_dyn(const ScrStr *qs);

/* node:util.parseArgs — the static checked-dynamic boundary. `config` is
 * the documented JSON-safe configuration object; the returned dyn tree is
 * a fresh ParsedResults object whose `values` child has null prototype.
 * Borrows config; returns +1, or NULL with a Node-coded TypeError pending. */
struct ScrDyn *scr_util_parse_args(const struct ScrDyn *config);
ScrStr *scr_util_style_text(const struct ScrDyn *format, const struct ScrDyn *text, const struct ScrDyn *options);
/* Node's terminal color decision (FORCE_COLOR, NO_COLOR, TERM, CI hosts)
 * once the stream is a terminal (scr_util_style.c). */
bool scr_util_terminal_colors(void);
/* util.inherits, util.deprecate, util.callbackify and util.debuglog
 * (scr_util_callable.c), and util.promisify over an untyped function
 * (scr_util_promisify.c). Arguments are borrowed; function results are +1
 * native dyn functions, or NULL with Node's TypeError pending. */
void scr_util_inherits(struct ScrDyn *ctor, struct ScrDyn *super_ctor);
void scr_util_inherits_prototype(struct ScrDyn *ctor, struct ScrDyn *super_ctor,
                                 struct ScrDyn *super_prototype);
struct ScrDyn *scr_util_deprecate(struct ScrDyn *fn, struct ScrDyn *msg, struct ScrDyn *code,
                                  struct ScrDyn *options);
struct ScrDyn *scr_util_callbackify(struct ScrDyn *original);
struct ScrDyn *scr_util_promisify(struct ScrDyn *original);
struct ScrDyn *scr_util_debuglog(struct ScrDyn *section, struct ScrDyn *callback);

/* Node/libuv system error utilities. Arguments are checked without coercion;
 * entries is a fresh array of [number, [name, message]] pairs (+1). */
ScrStr *scr_util_system_error_name(const struct ScrDyn *error);
ScrStr *scr_util_system_error_message(const struct ScrDyn *error);
struct ScrDyn *scr_util_system_error_entries(void);

/* Node 24's dotenv grammar, shared by util.parseEnv and process.loadEnvFile.
 * Arguments are borrowed; parseEnv returns a fresh ordinary object (+1).
 * Validation and file failures leave a coded exception pending. */
struct ScrDyn *scr_util_parse_env(const struct ScrDyn *content);
/* Checked primitives, ordinary records/arrays and byte views. Opaque native
 * objects and accessor descriptors retain explicit catchable refusals. */
bool scr_util_is_deep_strict_equal(const struct ScrDyn *a, const struct ScrDyn *b,
                                  const struct ScrDyn *skip_prototype);
void scr_process_load_env_file(const struct ScrDyn *path);

/* querystring.stringify — Node's stringify over a borrowed dyn value (the
 * frontend dynFroms the typed record; JS-world dyn values pass straight
 * through). Non-object dyn values answer "" like Node; object keys iterate in
 * JS own-key order (scr_dyn_obj_keys — array-index keys ascending first,
 * then insertion order, Node's ObjectKeys). Values serialize per Node's
 * encodeStringified: strings escape, finite numbers render shortest-
 * roundtrip then escape ('1e+21' → '1e%2B21'), booleans are bare
 * true/false, arrays expand to repeated keys (empty arrays emit NOTHING,
 * key included), and everything else (null, undefined, nested objects/
 * arrays, functions) is the empty value — key and eq still emitted.
 * sep/eq fall back to "&"/"=" when empty (Node's `sep ||= '&'`). Result
 * +1; a lone surrogate throws URIError [ERR_INVALID_URI] (NULL). */
ScrStr *scr_qs_stringify(const struct ScrDyn *obj, const ScrStr *sep,
                         const ScrStr *eq);

/* encodeURI — the same ECMA-262 Encode() with the reserved set and '#'
 * kept unescaped (scr_encode_uri_impl's keep_reserved arm). Throws the same
 * URIError on a lone surrogate. Borrows s; result +1. */
ScrStr *scr_encode_uri(ScrStr *s);
/* atob/btoa — the WHATWG base64 globals (Node globals since v16). The
 * argument is a borrowed dyn value: WebIDL ToString runs here over the
 * dyn kind (Node's atob(null) decodes "null"). scr_atob decodes
 * forgiving-base64 (ASCII whitespace stripped, %4==0 strips up to two
 * '=', %4==1 refuses, leftover bits discarded) into the latin1 code
 * points as a UTF-8 string; malformed input THROWS the catchable
 * DOMException InvalidCharacterError ("The string to be decoded is not
 * correctly encoded.") and returns NULL. scr_btoa encodes the string's
 * code points (any over U+00FF throws InvalidCharacterError "Invalid
 * character"). scr_b64_missing_arg is the zero-argument call of either:
 * always throws Node's TypeError [ERR_MISSING_ARGS] and returns NULL.
 * Results +1. */
ScrStr *scr_atob(const struct ScrDyn *data);
ScrStr *scr_btoa(const struct ScrDyn *data);
ScrStr *scr_b64_missing_arg(void);

#endif /* SCR_QS_H */
