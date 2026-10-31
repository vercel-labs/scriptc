/* scriptc runtime — strings: layout, lone surrogates (WTF-8), concatenation
 * and comparison (scr_string.c). Included by scr_runtime.h, which says where
 * new declarations go. */
#ifndef SCR_STRING_H
#define SCR_STRING_H

#include "scr_rc.h"

/* ── strings ──────────────────────────────────────────────────────────
 * UTF-8 bytes, refcounted, immutable. rc == SIZE_MAX marks an immortal
 * interned literal (emitted as a static object; retain/release are no-ops).
 * data is NUL-terminated for C convenience; len excludes the NUL.
 *
 * cap is the usable byte capacity of data[] excluding the NUL (allocation
 * is sizeof(ScrStr) + cap + 1); cap == len for interned literals and plain
 * allocations. Builders and concat results may have spare capacity so
 * scr_str_concat can append in place when the left operand is uniquely
 * owned (rc == 1) — observable immutability is preserved: a string with
 * rc > 1 or rc == SIZE_MAX is never mutated.
 *
 * On 64-bit little-endian targets the capacity word is split: the low half
 * is cap (strings never exceed SCR_STR_MAX_CAP bytes; JavaScript strings are
 * far shorter) and the high half caches the string's Map key hash (0 = not
 * computed). Emitted literals and runtime statics still initialize one
 * size-sized word to len, which leaves the hash half zero. Only uniquely
 * owned heap strings are ever mutated, and every such path clears the hash
 * (scr_str_hash_forget); immortal strings are never written, so they always
 * hash on demand.
 *
 * Bit 31 of the capacity word (on every target) is the proven-ASCII fact:
 * when set, every byte is below 0x80, so UTF-16 indices equal byte offsets
 * and .length == len. A clear bit means "not known", never "non-ASCII":
 * constructors set it only where it is cheap, and string reads that prove
 * ASCII set it later. Capacity therefore stops at 2^31 - 1 bytes, which
 * still holds every string V8 can represent (2^29 - 24 UTF-16 units, at
 * most three UTF-8 bytes each). Generated code reads the bit for inline
 * charCodeAt/length (llvm/strings.ts); emitted literals and runtime
 * statics set it in their capacity word. scr_str_hash_forget clears it
 * with the hash: every in-place mutation already forgets cached facts.
 */
#if SIZE_MAX > UINT32_MAX && defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define SCR_STR_HASH_CACHE 1
#else
#define SCR_STR_HASH_CACHE 0
#endif
#define SCR_STR_MAX_CAP ((size_t)0x7fffffff)
typedef struct ScrStr {
  size_t rc;
  size_t len;
#if SCR_STR_HASH_CACHE
  uint32_t cap : 31;
  uint32_t ascii : 1;
  uint32_t hash;
#else
  size_t cap : 31;
  size_t ascii : 1;
#endif
  char data[];
} ScrStr;

/* The capacity word of a static string: cap == len, the proven-ASCII bit,
 * plus the precomputed 32-bit key hash where the header caches one (0
 * leaves it to be computed). */
#define SCR_STR_ASCII_BIT ((size_t)1 << 31)
#if SCR_STR_HASH_CACHE
#define SCR_STR_CAP_WORD(len, hash32, ascii)                                  \
  ((size_t)(len) | ((ascii) ? SCR_STR_ASCII_BIT : 0) |                        \
   ((size_t)(uint32_t)(hash32) << 32))
#else
#define SCR_STR_CAP_WORD(len, hash32, ascii) ((size_t)(len) | ((ascii) ? SCR_STR_ASCII_BIT : 0))
#endif

void scr_str_hash_prime(ScrStr *s); /* scr_map.c; before a string becomes immortal */
/* Forget every cached content fact (key hash, proven ASCII) before a
 * uniquely owned string's bytes change. */
static inline void scr_str_hash_forget(ScrStr *s) {
#if SCR_STR_HASH_CACHE
  s->hash = 0;
#endif
  s->ascii = 0;
}

/* True only when every byte is proven below 0x80 (see above). */
static inline bool scr_str_known_ascii(const ScrStr *s) { return s->ascii; }

/* Record the UTF-16 length a string's producer counted (scr_string.c). */
void scr_str_note_utf16_len(ScrStr *s, size_t units);

/* Record a proven-ASCII fact. Immortal strings may live in read-only
 * memory and are shared across threads, so they are never written. */
static inline void scr_str_note_ascii(ScrStr *s) {
  if (s->rc != SIZE_MAX) s->ascii = 1;
}

/* memcpy for the short, variable-length copies of string construction
 * (identifiers, keys, number text): fixed-size overlapping moves instead of
 * a libc call. Longer spans keep the platform's bulk copy. */
static inline void scr_copy_bytes(char *dst, const char *src, size_t n) {
  if (n <= 16) {
    if (n >= 8) {
      uint64_t a, b;
      memcpy(&a, src, 8);
      memcpy(&b, src + n - 8, 8);
      memcpy(dst, &a, 8);
      memcpy(dst + n - 8, &b, 8);
    } else if (n >= 4) {
      uint32_t a, b;
      memcpy(&a, src, 4);
      memcpy(&b, src + n - 4, 4);
      memcpy(dst, &a, 4);
      memcpy(dst + n - 4, &b, 4);
    } else if (n) {
      dst[0] = src[0];
      dst[n / 2] = src[n / 2];
      dst[n - 1] = src[n - 1];
    }
    return;
  }
  memcpy(dst, src, n);
}

/* Whether a byte span is all ASCII: 32 bytes per step, stopping at the
 * first chunk with a high bit. */
static inline bool scr_bytes_all_ascii(const char *p, size_t n) {
  const uint64_t high = UINT64_C(0x8080808080808080);
  size_t i = 0;
  for (; n - i >= 32; i += 32) {
    uint64_t w[4];
    memcpy(w, p + i, sizeof w);
    if ((w[0] | w[1] | w[2] | w[3]) & high) return false;
  }
  uint64_t acc = 0;
  for (; n - i >= 8; i += 8) {
    uint64_t w;
    memcpy(&w, p + i, 8);
    acc |= w;
  }
  for (; i < n; i++) acc |= (unsigned char)p[i];
  return (acc & high) == 0;
}

/* Length of a byte span's ASCII prefix: 32 bytes per step through long
 * ASCII runs, then the chunk holding a high bit word by word. */
static inline size_t scr_bytes_ascii_span(const char *p, size_t n) {
  const uint64_t high = UINT64_C(0x8080808080808080);
  size_t i = 0;
  while (n - i >= 32) {
    uint64_t w[4];
    memcpy(w, p + i, sizeof w);
    if ((w[0] | w[1] | w[2] | w[3]) & high) break;
    i += 32;
  }
  while (n - i >= 8) {
    uint64_t w;
    memcpy(&w, p + i, 8);
    if (w & high) break;
    i += 8;
  }
  while (i < n && (unsigned char)p[i] < 0x80) i++;
  return i;
}

ScrStr *scr_str_new(const char *bytes, size_t len); /* returns +1 */
/* Native callback boundary: copy and WHATWG-decode a UTF-8 span, replacing
 * malformed subsequences with U+FFFD. NULL with len == 0 is an empty span. */
ScrStr *scr_str_from_utf8_lossy(const uint8_t *bytes, size_t len); /* +1 */
/* The same decode in place for bytes read straight into a uniquely owned
 * raw string (file contents) whose first `ascii` bytes the caller already
 * proved ASCII (0 when unknown): consumes `raw`, returns +1 (`raw` itself
 * when it is well formed). */
ScrStr *scr_str_adopt_utf8_lossy(ScrStr *raw, size_t ascii);
/* A runtime encoding name Node decodes as UTF-8 ("utf8"/"utf-8", any
 * ASCII case). */
bool scr_bytes_encoding_is_utf8(const ScrStr *enc);

/* Internal allocators for buffer builders: a +1 string with
 * UNINITIALIZED data (the builder fills bytes, then len and the NUL), and
 * an rc==1-only realloc that grows capacity in place. Both keep the RC
 * audit's live count exact. */
ScrStr *scr_str_alloc_raw(size_t len, size_t cap);
ScrStr *scr_str_regrow(ScrStr *s, size_t newcap);

static inline ScrStr *scr_str_retain(ScrStr *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_str_release(ScrStr *s); /* NULL-tolerant (uninitialized locals) */

/* A transient stack copy of a slice (scr_str_slice_scratch): immortal for
 * retain and release, and valid only while its borrowing consumer runs. No
 * other string has a capacity below its length. Containers that keep a
 * string they were lent store scr_str_scratch_keep's copy instead. */
static inline bool scr_str_is_scratch(const ScrStr *s) {
  return s->rc == SIZE_MAX && s->cap < s->len;
}

/* ── lone surrogates: canonical WTF-8 storage ─────────────────────────
 * String storage is UTF-8 extended to lone UTF-16 surrogates: an unpaired
 * surrogate is its generalized 3-byte encoding ED A0..BF 80..BF, while a
 * high surrogate directly followed by a low one is always stored as the
 * pair's 4-byte UTF-8 sequence. Canonical storage keeps byte equality,
 * hashing and searching exact. Builders preserve it by fusing a trailing
 * lone high surrogate with a leading lone low one (scr_wtf8_joins). A lone
 * surrogate is exactly as long as U+FFFD, so byte sinks transcode to UTF-8
 * (scr_str_utf8) without changing any length or offset. */

/* Set once a lone surrogate may exist anywhere in the process: program
 * startup stamps it when a literal holds one, and every runtime producer
 * notes it (scr_wtf8_put, scr_wtf8_note). Until then no string can hold a
 * lone surrogate, so builders and byte sinks skip all surrogate work. It is
 * process-wide (strings cross threads) and never cleared. */
extern bool scr_wtf8_lone;
static inline bool scr_wtf8_any(void) { return __atomic_load_n(&scr_wtf8_lone, __ATOMIC_RELAXED); }
void scr_wtf8_note(void);

/* Whether p starts a lone surrogate (p[1] must be readable: string data
 * is NUL-terminated). */
static inline bool scr_wtf8_surrogate_at(const char *p) {
  return (unsigned char)p[0] == 0xED && (unsigned char)p[1] >= 0xA0;
}

/* Whether p starts a lone low surrogate (p[1] readable, as above). */
static inline bool scr_wtf8_low_at(const char *p) {
  return (unsigned char)p[0] == 0xED && (unsigned char)p[1] >= 0xB0;
}

/* Whether appending b to a puts a lone high surrogate directly before a
 * lone low surrogate. Tests the first byte of b before anything else, so
 * ordinary text costs one compare. */
static inline bool scr_wtf8_joins(const char *a, size_t alen, const char *b, size_t blen) {
  return __builtin_expect(scr_wtf8_any() && (unsigned char)b[0] == 0xED && blen >= 3 &&
                              (unsigned char)b[1] >= 0xB0 && alen >= 3 &&
                              (unsigned char)a[alen - 3] == 0xED &&
                              ((unsigned char)a[alen - 2] & 0xF0) == 0xA0,
                          0);
}

/* The first lone surrogate in a span, or NULL. memchr-driven. */
const char *scr_wtf8_find_surrogate(const char *p, size_t n);
/* Fuse every adjacent lone high/low pair in place; returns the new length. */
size_t scr_wtf8_fuse(char *p, size_t n);
/* Restore canonical storage after a builder joined a lone high surrogate
 * to a lone low one: fuses in place and drops cached content facts. The
 * _from form starts at a byte offset before which storage is canonical. */
void scr_str_fuse_surrogates(ScrStr *s);
void scr_str_fuse_from(ScrStr *s, size_t from);
/* Replace every lone surrogate with U+FFFD in place (same length). */
void scr_wtf8_replace_surrogates(char *p, size_t n);
static inline void scr_wtf8_to_utf8(char *p, size_t n) {
  if (__builtin_expect(scr_wtf8_any(), 0)) scr_wtf8_replace_surrogates(p, n);
}
/* A string's bytes as well-formed UTF-8 for a byte sink: s->data itself,
 * or (only when s holds a lone surrogate) a malloc'd NUL-terminated copy
 * with each one replaced by U+FFFD, returned in *owned for the caller to
 * release with scr_str_utf8_end. *owned is NULL on the fast path. */
const char *scr_str_utf8_copy(const ScrStr *s, char **owned);
static inline const char *scr_str_utf8(const ScrStr *s, char **owned) {
  *owned = NULL;
  if (s->ascii || !scr_wtf8_any()) return s->data;
  return scr_str_utf8_copy(s, owned);
}
static inline void scr_str_utf8_end(char *owned) {
  if (owned) free(owned);
}
static inline bool scr_str_has_surrogate(const ScrStr *s) {
  return scr_wtf8_any() && !s->ascii && scr_wtf8_find_surrogate(s->data, s->len) != NULL;
}
/* Encode one UTF-16 code unit or code point as WTF-8 (1-4 bytes). */
size_t scr_wtf8_put(char *dst, uint32_t cp);

/* Borrow both args, return +1. */
ScrStr *scr_str_concat(ScrStr *a, ScrStr *b);
/* Borrow each part without mutation; return one independently owned result. */
ScrStr *scr_str_concat_parts(ScrStr *const *parts, size_t count);
/* Concatenate up to 16 string or number operands (parts[i] == NULL selects
 * nums[i], formatted like String(n)) onto an optional borrowed head, +1
 * result. The head may be appended in place under scr_str_concat's rule for
 * its left operand; parts are never mutated. */
ScrStr *scr_str_concat_mixed(ScrStr *head, ScrStr *const *parts, const double *nums, size_t count);
/* The same with the left operand / head MOVED in (`s = s + x` when nothing
 * else can observe `s`): one call instead of a snapshot retain, the
 * binding's release and the snapshot's release around a borrowing concat. */
ScrStr *scr_str_concat_move(ScrStr *a, ScrStr *b);
/* scr_str_concat_move(a, String.fromCharCode(code)) without building the
 * one-character string: an ASCII character appends to a uniquely owned a
 * in place. */
ScrStr *scr_str_concat_move_char_code(ScrStr *a, double code);
ScrStr *scr_str_concat_mixed_move(ScrStr *head, ScrStr *const *parts, const double *nums,
                                  size_t count);
/* a + String(x): scr_str_concat's contract with a number right operand. */
ScrStr *scr_str_concat_f64(ScrStr *a, double x);

bool scr_str_eq(ScrStr *a, ScrStr *b);

/* memcmp byte order == code-point order, which differs from JS UTF-16
 * code-unit order for non-BMP characters against U+E000..U+FFFF and for
 * lone surrogates. Returns <0, 0, >0. Relational string operators use
 * scr_str_cmp_u16. */
int scr_str_cmp(ScrStr *a, ScrStr *b);
/* a.localeCompare(b) with no locales/options: Node's root-locale order for
 * Latin-script text, code-point order outside it (scr_string.c). */
double scr_str_locale_compare(ScrStr *a, ScrStr *b);

/* ECMAScript string ordering: compare UTF-16 code units even though ScrStr
 * stores WTF-8. Returns <0, 0, >0. */
int scr_str_cmp_u16(ScrStr *a, ScrStr *b);
/* scr_str_cmp_u16 for two distinct strings that are not proven ASCII. */
int scr_str_cmp_u16_bytes(const ScrStr *a, const ScrStr *b);

#endif /* SCR_STRING_H */
