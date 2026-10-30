/* scriptc runtime — the string methods, URI coding and number parsing
 * (scr_string.c, scr_idna.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_STRING_METHODS_H
#define SCR_STRING_METHODS_H

#include "scr_error.h"

/* ── string methods ─────────────────────────────────────────────────
 * ECMA-262 observable semantics over UTF-8 storage with UTF-16 code-unit
 * indices. A per-instance side cache keeps length/cursor state and sparse
 * navigation checkpoints for large strings, making warmed
 * non-local indexed operations bounded by one checkpoint interval. All
 * double index/count arguments go through ToIntegerOrInfinity (NaN → 0, trunc
 * toward zero, ±Infinity kept), exactly like JS. Every function borrows its
 * ScrStr arguments; functions returning ScrStr* return a +1 reference.
 *
 * Where JS produces a *lone surrogate* — charAt on half of an astral
 * pair, or a slice boundary that splits a pair — the result holds that
 * surrogate (canonical WTF-8, see above).
 */

/* .length — number of UTF-16 code units (astral chars count as 2). */
double scr_str_utf16_len(ScrStr *s);

/* The receiver of an indexed scan whose UTF-16 code units the index cache
 * holds (scr_string.c), published so emitted length and charCodeAt reads of
 * that string are a compare and a load. Cleared whenever its entry drops
 * the units (release, append, eviction); all fields zero otherwise. Emitted
 * code reads it where SCR_TL is empty, and in worker executables on ELF
 * targets, whose thread-locals live in the executable's static TLS block. */
typedef struct ScrStrScan {
  const ScrStr *s;
  const uint16_t *units;
  size_t n;
} ScrStrScan;
extern SCR_TL ScrStrScan scr_str_scan;

/* charCodeAt(i): the i-th UTF-16 code unit as a number; for astral chars
 * returns the high (0xD800+) or low (0xDC00+) surrogate value depending on
 * which half i addresses. NaN when ToIntegerOrInfinity(i) is outside
 * [0, length) — note charCodeAt(1.5) is index 1, matching Node. */
double scr_str_char_code_at(ScrStr *s, double i);

/* Converts a non-ASCII s up to the units cap to UTF-16 at once and
 * publishes it in scr_str_scan, for a loop about to read it between the
 * indexes `from` and `to` (NaN: no bound), when that range has at least
 * one unit per 16 bytes. A shorter loop counts as one indexed read. Leaves
 * scr_str_scan unchanged for any other s. */
void scr_str_scan_units_for(ScrStr *s, double from, double to);

/* indexOf(needle, fromIndex): UTF-16 index of the first occurrence at or
 * after fromIndex (clamped to [0, length]), or -1. Empty needle returns the
 * clamped fromIndex per spec. */
double scr_str_index_of(ScrStr *s, ScrStr *needle, double fromIndex);

/* lastIndexOf(needle): the one-argument form returns the last occurrence's
 * UTF-16 index, or -1. Empty needle returns length. */
double scr_str_last_index_of(ScrStr *s, ScrStr *needle);

/* lastIndexOf(needle, position): search at or before the clamped UTF-16
 * position. NaN starts at the end, including for an empty needle. */
double scr_str_last_index_of_from(ScrStr *s, ScrStr *needle, double position);

/* includes(needle) — no position argument. Empty needle → true. */
bool scr_str_includes(ScrStr *s, ScrStr *needle);

/* startsWith(needle) / endsWith(needle) — one-argument forms. */
bool scr_str_starts_with(ScrStr *s, ScrStr *needle);
bool scr_str_ends_with(ScrStr *s, ScrStr *needle);

/* Positioned forms clamp UTF-16 indices to [0, length]. The empty needle
 * matches at every clamped position. */
bool scr_str_starts_with_from(ScrStr *s, ScrStr *needle, double position);
bool scr_str_ends_with_from(ScrStr *s, ScrStr *needle, double end_position);

/* slice(start, end): UTF-16 indices, negatives count from length, clamped
 * to [0, length]; empty when start >= end. The frontend passes
 * end = Infinity for the one-argument form. Boundaries that split an astral
 * pair keep the half character as a lone surrogate. Returns +1. */
ScrStr *scr_str_slice(ScrStr *s, double start, double end);
/* substring: clamp-and-swap (negatives clamp to 0, start > end swaps). */
ScrStr *scr_str_substring(ScrStr *s, double start, double end);
/* Annex B substr(start, length): start already ToNumber'd (NaN → 0), a
 * negative start counts from the end, length absent (has_length false)
 * runs to the end. Returns +1. */
ScrStr *scr_str_substr(ScrStr *s, double start, double length, bool has_length);

/* Scalar-only local slices retain their original owner without copying.
 * Bounds and split-surrogate replacements are snapshotted at construction. */
typedef struct ScrStringSlice {
  size_t start, length;
  uint32_t split;
} ScrStringSlice;
void scr_str_slice_range(ScrStr *s, double start, double end, bool substring,
                         ScrStringSlice *out);
double scr_str_slice_char_code_at(ScrStr *s, const ScrStringSlice *range, double index);
/* A slice that only borrowing consumers read (string-slices.ts) is written
 * into the caller's `bytes`-sized stack buffer as an immortal ASCII string,
 * whose header marks it as a scratch copy (scr_str_is_scratch). Results
 * that do not fit, are not ASCII, or are interned statics are returned as
 * the ordinary +1 slice. Releasing either result is correct. */
ScrStr *scr_str_slice_scratch(ScrStr *s, double start, double end, bool substring,
                              ScrStr *scratch, size_t bytes);
/* The owning reference a container stores for `s`: a heap copy of a scratch
 * string, else `s` retained. */
ScrStr *scr_str_scratch_keep(ScrStr *s);

/* repeat(count): count < 0 or Infinity is a JS RangeError; scriptc has no
 * exceptions, so it prints "scriptc: RangeError: Invalid count value" to
 * stderr and abort()s. Returns +1. */
ScrStr *scr_str_repeat(ScrStr *s, double count);

/* trim(): strips the exact JS WhiteSpace ∪ LineTerminator set from both
 * ends (U+0009-U+000D, U+0020, U+00A0, U+1680, U+2000..U+200A, U+2028,
 * U+2029, U+202F, U+205F, U+3000, U+FEFF). Returns +1. */
ScrStr *scr_str_trim(ScrStr *s);

/* toLowerCase()/toUpperCase(): ECMA-262 Default Case Conversion (final
 * sigma included) via libunicode's lre_case_conv — implemented in
 * scr_regex.c, so they link exactly into lre-using binaries (the compiler
 * sets the regex link flag for case-conversion sites). Borrow s; +1. */
ScrStr *scr_str_to_lower(const ScrStr *s);
ScrStr *scr_str_to_upper(const ScrStr *s);
ScrStr *scr_str_normalize(const ScrStr *s, const ScrStr *form);
/* toLocaleLowerCase/toLocaleUpperCase(locales) (scr_regex.c): undefined,
 * empty lists, and primitives other than strings use the default case
 * conversion; the first requested tag selects the Turkic (tr, az) rules or
 * the default ones. Lithuanian, Greek uppercasing and tags outside the
 * structural grammar throw a 'not supported yet' Error; null throws Node's
 * TypeError. Borrows both; +1 or NULL with an exception pending. */
ScrStr *scr_str_locale_case(const ScrStr *s, struct ScrDyn *locales, bool upper);
/* NFC over a code point buffer (scr_regex.c, beside normalize): a fresh
 * malloc'd buffer the caller frees, its length in *out_len. Borrows input. */
uint32_t *scr_nfc_code_points(const uint32_t *input, size_t length, size_t *out_len);

/* UTS #46 domain conversion (scr_idna.c — the url unit's IDNA tables; it
 * rides the regex switch for NFC). to_ascii answers "" on failure;
 * to_unicode decodes each valid Punycode label and never fails. Both
 * borrow the UTF-8 span and return +1. */
ScrStr *scr_idna_to_ascii(const char *p, size_t n);
ScrStr *scr_idna_to_unicode(const char *p, size_t n);

/* charAt(i): 1-code-unit string; out of range → empty string. Half of an
 * astral pair → that lone surrogate. Returns +1. */
ScrStr *scr_str_char_at(ScrStr *s, double i);

/* The string iterator's step (for-of over strings): the full code-POINT
 * character starting at UTF-16 index i — astral chars come back whole
 * (two units); the consuming loop advances by the result's length.
 * Out of range → empty string. Returns +1. */
ScrStr *scr_str_cp_at(ScrStr *s, double i);
/* The string iterator's step over the WTF-8 bytes: the code-point
 * character whose encoding starts at byte offset b, a character start
 * below s->len (a lone surrogate is its own three-byte character). The
 * compiler answers ASCII bytes inline and calls this for the rest.
 * Returns +1. */
ScrStr *scr_str_cp_at_byte(ScrStr *s, uint64_t b);
/* [...s] and Array.from(s): the code-point characters of s in order, as a
 * fresh string array of exactly that length. Returns +1. */
struct ScrArr *scr_str_code_points(ScrStr *s);

/* trimStart()/trimEnd(): the one-sided halves of trim. Returns +1. */
ScrStr *scr_str_trim_start(ScrStr *s);
ScrStr *scr_str_trim_end(ScrStr *s);

/* split(separator[, limit]) with a STRING separator: limit uses ToUint32;
 * the no-limit wrapper supplies 2^32-1. Empty separator
 * splits into single UTF-16 code units (each half of an astral char is
 * a lone surrogate); otherwise splits on every occurrence,
 * empty pieces kept. Borrows both; returns a +1 string[] (SCR_ELEM_STR). */
struct ScrArr;
/* String.prototype.replace/replaceAll with a string search value and a
 * string replacement: GetSubstitution without captures ($$, $&, $`, $';
 * every other '$' spelling stays literal). An empty search value matches
 * at 0, or at every UTF-16 position under replaceAll. Borrows; +1. */
ScrStr *scr_str_replace_literal(ScrStr *s, ScrStr *search, ScrStr *rep, bool all);
/* Every occurrence of the ASCII byte chars[k] replaced by the k-th
 * NUL-separated text of `texts`, in one pass (at most 16 distinct
 * characters; the compiler fuses chains of global one-character
 * replacements into it). Borrows all three; +1. */
ScrStr *scr_str_replace_chars(ScrStr *s, ScrStr *chars, ScrStr *texts);
/* The same over a nonempty canonical WTF-8 needle (literal regex
 * patterns share it). Borrows; +1. */
ScrStr *scr_str_replace_bytes(ScrStr *s, const char *pat, size_t plen, ScrStr *rep, bool all);
/* First occurrence of a nonempty needle in a byte span, or NULL. */
const char *scr_str_find_bytes(const char *hay, size_t hay_len, const char *needle,
                               size_t needle_len);
struct ScrArr *scr_str_split(ScrStr *s, ScrStr *sep);
struct ScrArr *scr_str_split_limit(ScrStr *s, ScrStr *sep, double limit);
/* Internal dense split traversal. The cursor borrows input strings, returns
 * one owned piece per step, and uses NULL only for exhaustion. Its layout
 * is shared with generated stack storage, including wasm32. */
typedef struct ScrSplitCursor {
  size_t offset;
  uint32_t remaining;
  uint32_t pending_unit; /* the low surrogate still owed by a split pair */
  char unit[4];          /* the bytes of the current surrogate piece */
} ScrSplitCursor;
void scr_str_split_cursor_init(ScrSplitCursor *cursor, uint32_t limit);
/* Optional scratch is a separately owned, NULL-initialized string slot.
 * A piece that has not escaped can reuse it after the preceding yield is
 * released. The caller releases the slot on every exit; NULL disables reuse. */
ScrStr *scr_str_split_cursor_next(ScrStr *s, ScrStr *sep, ScrSplitCursor *cursor,
                                  ScrStr **scratch);
/* Borrowed split bytes remain valid while the source snapshot is owned.
 * Materialization returns +1 and uses the same optional scratch contract. */
const char *scr_str_split_cursor_span(ScrStr *s, ScrStr *sep, ScrSplitCursor *cursor,
                                     size_t *length);
ScrStr *scr_str_split_materialize(const char *bytes, size_t length, ScrStr **scratch);

/* padStart(maxLength, fill)/padEnd — ECMA StringPad, UTF-16 unit counts.
 * Target at or below the length (or empty fill) returns the receiver
 * (retained). A truncated fill that would split an astral char keeps its
 * high half as a lone surrogate. Oversized pads abort (the repeat() policy).
 * Borrow both; return +1. */
ScrStr *scr_str_pad_start(ScrStr *s, double maxLength, ScrStr *fill);
ScrStr *scr_str_pad_end(ScrStr *s, double maxLength, ScrStr *fill);

/* isWellFormed()/toWellFormed(): whether s holds no lone surrogate, and
 * s with each lone surrogate replaced by U+FFFD (s itself, retained, when
 * it has none). Borrow s; toWellFormed +1. */
bool scr_str_is_well_formed(ScrStr *s);
ScrStr *scr_str_to_well_formed(ScrStr *s);
/* Node text utilities: borrowed input, +1 result or NULL+pending. The VT
 * helper lives in the optional regex unit; USV conversion uses native strings. */
ScrStr *scr_util_strip_vt(const struct ScrDyn *input);
ScrStr *scr_util_to_usv_string(const struct ScrDyn *input);
ScrStr *scr_util_to_string(const struct ScrDyn *input); /* ToString alone */
void scr_dyn_install_to_primitive_symbol(struct ScrDyn *key);

/* RegExp.escape(s) — ES2025 EncodeForRegExpEscape per code point: leading
 * ASCII alphanumeric hex-escapes, SyntaxCharacters and '/' take a
 * backslash, other punctuators/whitespace/line terminators hex-escape
 * (\xNN / \uNNNN, lowercase), a lone surrogate \uNNNN-escapes, the rest
 * passes through. Total. Lives in
 * scr_regex.c (no engine needed — the placement keeps the always-linked
 * string TU out of hello-world's size class); use sites flip the regex
 * link switch (moduleUsesRegex). Borrows; +1. */
ScrStr *scr_regexp_escape(ScrStr *s);

/* parseInt(s, radix) — ECMA-262 19.2.5 exactly: JS whitespace skip, sign,
 * ToInt32 radix (0 → 10 with the 0x hex escape; outside 2..36 → NaN),
 * longest digit prefix, exact value correctly rounded (overflow →
 * ±Infinity). The frontend completes an omitted radix to 0. Borrows s. */
double scr_parse_int(ScrStr *s, double radix);
/* parseInt over a borrowed UTF-8 byte span. */
double scr_parse_int_bytes(const char *p, size_t n, double radix);
/* parseInt(p, 10) when p is 1..15 ASCII digits and nothing else: exact in
 * a u64 and in a double. False for every other input. */
static inline bool scr_parse_int_short_digits(const char *p, size_t n, double *out) {
  if (n - 1 >= 15) return false;
  uint64_t acc = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned d = (unsigned char)p[i] - (unsigned)'0';
    if (d > 9) return false;
    acc = acc * 10 + d;
  }
  *out = (double)(int64_t)acc; /* < 10^15: the signed conversion is exact and cheaper */
  return true;
}
double scr_parse_float(ScrStr *s);

/* ToNumber(string) — ECMA-262 7.1.4.1 StringToNumber exactly: trim
 * StrWhiteSpace (the JS set, line terminators included) from both ends,
 * empty/whitespace-only → +0, then the WHOLE remaining span must be one
 * StrNumericLiteral — a signed decimal literal ("Infinity" exact-case
 * included, correctly rounded via strtod over the validated span) or an
 * UNSIGNED 0x/0o/0b integer literal (exact value rounded to nearest-even;
 * a sign on those is NaN, per grammar). Any trailing garbage → NaN.
 * Borrows s; never throws. */
double scr_string_to_number(ScrStr *s);
/* StringToNumber over a borrowed UTF-8 byte span. */
double scr_bytes_to_number(const char *p, size_t len);

/* encodeURIComponent — ECMA-262 Encode with the component unreserved set
 * (ALPHA/DIGIT/- _ . ! ~ * ' ( )): every other byte of the UTF-8 string
 * percent-encodes as uppercase %XX (the spec's per-code-point UTF-8
 * encoding IS a byte scan over UTF-8 storage). A lone surrogate throws the
 * spec's URIError ("URI malformed"). Borrows s; result +1. */
ScrStr *scr_str_encode_uri_component(ScrStr *s);
/* querystring.escape: the component encoder, throwing Node's URIError
 * [ERR_INVALID_URI] on a lone surrogate. Borrows s; result +1. */
ScrStr *scr_qs_escape(ScrStr *s);
/* lib/internal/querystring.js encodeStr over UTF-16 code units: ASCII
 * outside `no_escape` and every non-ASCII code unit percent-encode as
 * UTF-8, and ANY surrogate pairs with the code unit after it (Node's own
 * rule); only a surrogate in last position throws URIError
 * [ERR_INVALID_URI] and returns NULL. Borrows s; +1. */
ScrStr *scr_qs_encode_str(const ScrStr *s, const signed char no_escape[128]);

/* decodeURIComponent — ECMA-262 Decode with the empty reserved set: %XX
 * escapes decode bytewise (raw non-escape bytes copy through) and escaped
 * multibyte sequences must be strictly valid UTF-8 (overlong forms,
 * surrogates, >U+10FFFF refused — UTF8-decode without replacement). Bad
 * hex or an invalid sequence THROWS the spec's catchable URIError ("URI
 * malformed") and returns NULL. Borrows s; result +1. */
ScrStr *scr_str_decode_uri_component(ScrStr *s);
ScrStr *scr_str_decode_uri(ScrStr *s);

/* The non-throwing core of decodeURIComponent: NULL on malformed input
 * instead of the URIError — the try/catch shape node:querystring's
 * unescape wraps around decodeURIComponent (scr_qs.c's strict pass). */
ScrStr *scr_str_decode_uri_component_try(ScrStr *s);

#endif /* SCR_STRING_METHODS_H */
