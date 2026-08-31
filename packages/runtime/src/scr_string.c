#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Live heap-string count for the RC audit lane (-DSCR_RC_AUDIT): the test
 * harness builds with it to prove the emitted retain/release discipline
 * leaks nothing and frees nothing twice (double-free shows up as ASan
 * use-after-free on the rc field or a negative count here). */
#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_strings = 0;
long scr_str_live_count(void) { return scr_live_strings; }
#endif

static void scr_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── UTF-16 index cache ───────────────────────────────────────────────
 * JS string semantics are UTF-16 indices over our UTF-8 storage, so
 * .length, charCodeAt, charAt, indexOf and slice all need unit↔byte
 * conversions. The four-entry direct cache keeps the old hot cursor for
 * tiny and allocation-failure traffic. Large strings are promoted to an
 * owned per-thread side registry with sparse `{ UTF-16 unit, UTF-8 byte }`
 * checkpoints, so cycling more than four live receivers does not throw
 * away a warmed index. A non-local lookup then decodes at most one
 * checkpoint interval instead of a prefix proportional to its requested
 * index.
 *
 * Checkpoints are owned by the entry, not the ScrStr ABI: the representation
 * remains the three-word UTF-8 ScrStr used by literals, FFI and generated
 * code. Checkpoints cost two size_ts every 4 KiB (about 0.39% of indexed
 * bytes); their small registry records are retained only while the owning
 * large ScrStr is live, then freed on release/realloc, executable exit, and
 * every library reset. The four inline entries are eagerly reused. SCR_TL
 * makes the direct table, registry, and owned buffers instance-local for
 * SCR_THREAD_INSTANCES. Metadata allocation is strictly an optimization:
 * overflow or malloc failure falls back to the inline cursor mapper.
 */
#define SCR_SIDX_N 4
#define SCR_U16_UNKNOWN SIZE_MAX
#define SCR_SIDX_MIN_BYTES ((size_t)64 * 1024)
#define SCR_SIDX_STRIDE_BYTES ((size_t)4 * 1024)
typedef struct {
  size_t cu; /* UTF-16 code-unit offset, always a code-point boundary */
  size_t cb; /* matching UTF-8 byte offset, never a continuation byte */
} ScrSidxPoint;
typedef struct ScrSidx {
  const ScrStr *s;       /* NULL = empty slot */
  size_t u16len;         /* SCR_U16_UNKNOWN until the whole current string */
  size_t cu, cb;         /* hot cursor: cb starts the char at unit cu */
  ScrSidxPoint *points;  /* sparse, ordered code-point-boundary anchors */
  size_t npoints, cap;   /* owned points length/capacity */
  size_t indexed_cu;     /* exact contiguous prefix indexed from byte zero */
  size_t indexed_cb;
  bool no_more_points;   /* metadata allocation failed/overflowed: fail open */
  struct ScrSidx *next;  /* large-string side-registry link (never inline) */
} ScrSidx;
static SCR_TL ScrSidx scr_sidx_tab[SCR_SIDX_N];
static SCR_TL unsigned scr_sidx_clock;
static SCR_TL ScrSidx *scr_sidx_large;
static SCR_TL bool scr_sidx_cleanup_registered;

static void scr_sidx_clear(ScrSidx *e) {
  free(e->points);
  memset(e, 0, sizeof(*e));
}

static void scr_sidx_destroy(ScrSidx *e) {
  scr_sidx_clear(e);
  free(e);
}

static void scr_sidx_reset_all(void) {
  for (int i = 0; i < SCR_SIDX_N; i++) scr_sidx_clear(&scr_sidx_tab[i]);
  while (scr_sidx_large) {
    ScrSidx *e = scr_sidx_large;
    scr_sidx_large = e->next;
    scr_sidx_destroy(e);
  }
  scr_sidx_clock = 0;
}

static void scr_sidx_register_cleanup(void) {
  if (!scr_sidx_cleanup_registered) {
    scr_sidx_cleanup_registered = true;
    scr_atexit(scr_sidx_reset_all);
  }
}

#ifdef SCR_SIDX_TEST
static SCR_TL size_t scr_sidx_walk_steps;
void scr_sidx_test_reset_steps(void) { scr_sidx_walk_steps = 0; }
size_t scr_sidx_test_walk_steps(void) { return scr_sidx_walk_steps; }
void scr_sidx_test_reset_cache(void) { scr_sidx_reset_all(); }
size_t scr_sidx_test_entries(void) {
  size_t n = 0;
  for (int i = 0; i < SCR_SIDX_N; i++) n += scr_sidx_tab[i].s != NULL;
  for (ScrSidx *e = scr_sidx_large; e; e = e->next) n++;
  return n;
}
size_t scr_sidx_test_points(void) {
  size_t n = 0;
  for (int i = 0; i < SCR_SIDX_N; i++) n += scr_sidx_tab[i].npoints;
  for (ScrSidx *e = scr_sidx_large; e; e = e->next) n += e->npoints;
  return n;
}
#define SCR_SIDX_STEP() (scr_sidx_walk_steps++)
#else
#define SCR_SIDX_STEP() ((void)0)
#endif

static void scr_sidx_purge(const ScrStr *s) {
  for (int i = 0; i < SCR_SIDX_N; i++) {
    if (scr_sidx_tab[i].s == s) scr_sidx_clear(&scr_sidx_tab[i]);
  }
  ScrSidx **link = &scr_sidx_large;
  while (*link) {
    ScrSidx *e = *link;
    if (e->s != s) {
      link = &e->next;
      continue;
    }
    *link = e->next;
    scr_sidx_destroy(e);
  }
}

static ScrSidx *scr_sidx_inline(const ScrStr *s) {
  for (int i = 0; i < SCR_SIDX_N; i++) {
    if (scr_sidx_tab[i].s == s) return &scr_sidx_tab[i];
  }
  ScrSidx *e = &scr_sidx_tab[scr_sidx_clock++ % SCR_SIDX_N];
  scr_sidx_clear(e);
  e->s = s;
  e->u16len = SCR_U16_UNKNOWN;
  return e;
}

/* The tiny direct table is intentionally only a hot cursor cache. Once a
 * receiver is large enough to justify checkpoints, its navigation state is
 * promoted into this list and survives inline-slot churn. This avoids the
 * old five-receiver cliff while preserving the ABI and keeping small-string
 * traffic allocation-free. If allocating the record fails, the inline cache
 * remains a correct one-cursor fallback. */
static ScrSidx *scr_sidx(const ScrStr *s) {
  if (s->len < SCR_SIDX_MIN_BYTES) return scr_sidx_inline(s);
  for (ScrSidx *e = scr_sidx_large; e; e = e->next) {
    if (e->s == s) return e;
  }
  for (int i = 0; i < SCR_SIDX_N; i++) {
    ScrSidx *inline_e = &scr_sidx_tab[i];
    if (inline_e->s != s) continue;
    ScrSidx *e = malloc(sizeof(*e));
    if (!e) {
      inline_e->no_more_points = true;
      return inline_e;
    }
    *e = *inline_e;
    memset(inline_e, 0, sizeof(*inline_e));
    e->next = scr_sidx_large;
    scr_sidx_large = e;
    scr_sidx_register_cleanup();
    return e;
  }
  ScrSidx *e = calloc(1, sizeof(*e));
  if (!e) {
    ScrSidx *inline_e = scr_sidx_inline(s);
    inline_e->no_more_points = true;
    return inline_e;
  }
  e->s = s;
  e->u16len = SCR_U16_UNKNOWN;
  e->next = scr_sidx_large;
  scr_sidx_large = e;
  scr_sidx_register_cleanup();
  return e;
}

/* In-place concat changes only the suffix. Keep every exact prefix anchor
 * (including the former end, which is now an ordinary boundary), but remove
 * the sole fact that described the old complete string. Side-registry
 * records need the same treatment as inline cursor entries. */
static void scr_sidx_concat_append(const ScrStr *s, size_t oldlen) {
  for (int i = 0; i < SCR_SIDX_N; i++) {
    ScrSidx *e = &scr_sidx_tab[i];
    if (e->s != s) continue;
    e->u16len = SCR_U16_UNKNOWN;
    if (e->indexed_cb > oldlen) e->indexed_cb = oldlen;
  }
  for (ScrSidx *e = scr_sidx_large; e; e = e->next) {
    if (e->s != s) continue;
    e->u16len = SCR_U16_UNKNOWN;
    if (e->indexed_cb > oldlen) e->indexed_cb = oldlen;
  }
}

/* ── allocation ─────────────────────────────────────────────────────── */

static ScrStr *scr_str_alloc(size_t len, size_t cap) {
  ScrStr *s = malloc(sizeof(ScrStr) + cap + 1);
  if (!s) scr_oom();
  s->rc = 1;
  s->len = len;
  s->cap = cap;
#ifdef SCR_RC_AUDIT
  scr_live_strings++;
#endif
  return s;
}

ScrStr *scr_str_new(const char *bytes, size_t len) {
  ScrStr *s = scr_str_alloc(len, len);
  memcpy(s->data, bytes, len);
  s->data[len] = '\0';
  return s;
}

/* One-slot free-block cache for concat callers that must copy: observable
 * aliases, `s = s + s`, and non-canonical concat shapes still allocate a
 * replacement result. The compiler's canonical self-assignment handoff
 * leaves its left snapshot uniquely owned, so it instead uses the in-place
 * path below; this cache remains useful for the copy cases. Disabled in the
 * audit lane so ASan sees every logical free as a real free. */
#ifndef SCR_RC_AUDIT
static SCR_TL ScrStr *scr_str_spare;
#endif

/* A spare-block reuse must not waste grossly (cap <= 4x the need) and only
 * sizable blocks are worth stashing (>= 512). */
static ScrStr *scr_str_take_spare(size_t len) {
#ifndef SCR_RC_AUDIT
  ScrStr *s = scr_str_spare;
  if (s && s->cap >= len && s->cap / 4 <= len) {
    scr_str_spare = NULL;
    s->rc = 1;
    s->len = len; /* keeps its larger cap */
    return s;
  }
#else
  (void)len;
#endif
  return NULL;
}

/* Builder entry points (scr_json.c): raw block with undefined bytes, and
 * an rc==1-only grow. The spare block is worth trying first — a stringify
 * loop's previous output is usually the right size for the next one. */
ScrStr *scr_str_alloc_raw(size_t len, size_t cap) {
  ScrStr *s = scr_str_take_spare(cap);
  if (!s) return scr_str_alloc(len, cap);
  s->len = len; /* keeps its (possibly larger) cap */
  return s;
}

ScrStr *scr_str_regrow(ScrStr *s, size_t newcap) {
  scr_sidx_purge(s); /* realloc may move; the old address may be recycled */
  ScrStr *r = realloc(s, sizeof(ScrStr) + newcap + 1);
  if (!r) scr_oom();
  r->cap = newcap;
  return r;
}

void scr_str_release(ScrStr *s) {
  if (!s || s->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--s->rc == 0) {
    scr_sidx_purge(s); /* the address may be recycled by the next malloc */
#ifdef SCR_RC_AUDIT
    scr_live_strings--;
#endif
#ifndef SCR_RC_AUDIT
    if (s->cap >= 512) {
      ScrStr *old = scr_str_spare;
      scr_str_spare = s;
      if (!old) return;
      s = old; /* evict the previous spare */
    }
#endif
    free(s);
  }
}

ScrStr *scr_str_concat(ScrStr *a, ScrStr *b) {
  if (a->len > SIZE_MAX - b->len - sizeof(ScrStr) - 1) scr_oom();
  size_t newlen = a->len + b->len;
  /* In-place append: a is uniquely owned by the caller's borrow (rc == 1 —
   * never an interned literal, those are SIZE_MAX) and has room. Fires on
   * concat chains (`a + b + c`, template literals), where each intermediate
   * result reaches the next concat as a sole-reference temp. Any string
   * with rc > 1 might be aliased and is copied, never mutated. */
  if (a->rc == 1 && a != b && a->cap >= newlen) {
    size_t oldlen = a->len;
    memcpy(a->data + a->len, b->data, b->len);
    a->len = newlen;
    a->data[newlen] = '\0';
    /* A cached UTF-16 length for a is stale now; checkpoints and the exact
     * old prefix remain valid. Its old terminal point is no longer an END
     * fact (u16len is invalidated below), but remains an excellent ordinary
     * checkpoint for accesses around the append boundary. The next mapper
     * lazily continues from oldlen rather than scanning the unchanged prefix
     * again. */
    scr_sidx_concat_append(a, oldlen);
    a->rc = 2; /* +1 for the returned reference, beside the caller's borrow */
    return a;
  }
  /* Copy path. Geometric slack keeps uniquely-owned concat chains and the
   * optimized self-assignment handoff amortized when they outgrow capacity.
   * Aliases and `s = s + s` deliberately arrive with rc > 1 and stay on this
   * path, preserving string immutability; their sizable replacement results
   * can still benefit from the spare-block cache above. */
  size_t newcap = newlen;
  if (a->rc == 1) {
    size_t grown = a->cap + (a->cap >> 1) + 16;
    if (grown > newcap) newcap = grown;
  } else if (newlen >= 512 && newlen <= (SIZE_MAX - sizeof(ScrStr) - 1) / 2) {
    newcap = newlen + (newlen >> 1);
  }
  ScrStr *s = scr_str_take_spare(newlen);
  if (!s) s = scr_str_alloc(newlen, newcap);
  memcpy(s->data, a->data, a->len);
  memcpy(s->data + a->len, b->data, b->len);
  s->data[newlen] = '\0';
  return s;
}

bool scr_str_eq(ScrStr *a, ScrStr *b) {
  return a == b || (a->len == b->len && memcmp(a->data, b->data, a->len) == 0);
}

int scr_str_cmp(ScrStr *a, ScrStr *b) {
  size_t min = a->len < b->len ? a->len : b->len;
  int c = memcmp(a->data, b->data, min);
  if (c != 0) return c;
  return a->len < b->len ? -1 : (a->len > b->len ? 1 : 0);
}

/* UTF-16 code-unit comparison over well-formed UTF-8 (the default
 * Array.sort/toSorted and URLSearchParams.sort order). Byte order ALMOST
 * matches — the exception is U+E000..U+FFFF (3-byte UTF-8, single high code
 * units) vs supplementary code points (4-byte UTF-8, surrogate pairs
 * 0xD800..0xDFFF): bytes put the 4-byte form last, code units put it first.
 * Decode code points and compare their leading UTF-16 units. */
static uint32_t scr_str_lead_u16(const unsigned char *s, size_t len,
                                size_t *adv) {
  unsigned char b = s[0];
  uint32_t cp;
  size_t n;
  if (b < 0x80) {
    cp = b; n = 1;
  } else if ((b & 0xe0) == 0xc0) {
    cp = b & 0x1fu; n = 2;
  } else if ((b & 0xf0) == 0xe0) {
    cp = b & 0x0fu; n = 3;
  } else {
    cp = b & 0x07u; n = 4;
  }
  if (n > len) n = len; /* defensive: strings are well-formed by contract */
  for (size_t i = 1; i < n; i++) cp = (cp << 6) | (s[i] & 0x3fu);
  *adv = n;
  if (cp >= 0x10000) return 0xd800 + ((cp - 0x10000) >> 10);
  return cp;
}

int scr_str_cmp_u16(ScrStr *a, ScrStr *b) {
  size_t ia = 0, ib = 0;
  while (ia < a->len && ib < b->len) {
    size_t na, nb;
    uint32_t ua = scr_str_lead_u16(
        (const unsigned char *)a->data + ia, a->len - ia, &na);
    uint32_t ub = scr_str_lead_u16(
        (const unsigned char *)b->data + ib, b->len - ib, &nb);
    if (ua != ub) return ua < ub ? -1 : 1;
    /* Equal leading units: equal whole code points (both single units or
     * both pairs with equal highs — lows only differ if cps differ). */
    if (na == 4 && nb == 4) {
      uint32_t cpa = 0, cpb = 0;
      for (size_t i = 0; i < 4; i++) {
        cpa = (cpa << 6) |
              (i == 0 ? (unsigned char)a->data[ia] & 0x07u
                      : (unsigned char)a->data[ia + i] & 0x3fu);
        cpb = (cpb << 6) |
              (i == 0 ? (unsigned char)b->data[ib] & 0x07u
                      : (unsigned char)b->data[ib + i] & 0x3fu);
      }
      if (cpa != cpb) return cpa < cpb ? -1 : 1;
    }
    ia += na;
    ib += nb;
  }
  if (ia < a->len) return 1;
  if (ib < b->len) return -1;
  return 0;
}

/* ── interned strings ─────────────────────────────────────────────────
 * The empty string and every single-character ASCII string are immortal
 * statics (same layout the emitter uses for literals): charAt/slice churn
 * in tight loops returns these without allocating.
 */
typedef struct { size_t rc; size_t len; size_t cap; char data[2]; } ScrChar1;
#define SCR_A(c) {SIZE_MAX, 1, 1, {(char)(c), 0}}
#define SCR_A8(c) \
  SCR_A(c), SCR_A(c + 1), SCR_A(c + 2), SCR_A(c + 3), \
  SCR_A(c + 4), SCR_A(c + 5), SCR_A(c + 6), SCR_A(c + 7)
static const ScrChar1 scr_ascii1[128] = {
  SCR_A8(0),   SCR_A8(8),   SCR_A8(16),  SCR_A8(24),
  SCR_A8(32),  SCR_A8(40),  SCR_A8(48),  SCR_A8(56),
  SCR_A8(64),  SCR_A8(72),  SCR_A8(80),  SCR_A8(88),
  SCR_A8(96),  SCR_A8(104), SCR_A8(112), SCR_A8(120),
};
static const struct { size_t rc; size_t len; size_t cap; char data[1]; }
    scr_lit_empty = {SIZE_MAX, 0, 0, ""};

static ScrStr *scr_str_empty(void) { return (ScrStr *)&scr_lit_empty; }

/* Interned when the content is empty or one ASCII byte; fresh otherwise. */
static ScrStr *scr_str_from_span(const char *bytes, size_t len) {
  if (len == 0) return scr_str_empty();
  if (len == 1 && (unsigned char)bytes[0] < 0x80) {
    return (ScrStr *)&scr_ascii1[(unsigned char)bytes[0]];
  }
  return scr_str_new(bytes, len);
}

/* ── string methods: UTF-16 semantics over UTF-8 storage ──────────
 * All strings in the system are well-formed UTF-8 (the compiler replaces
 * lone surrogates in literals with U+FFFD), so the decode helpers below
 * may assume valid sequences and never validate.
 */

/* UTF-8 encoding of U+FFFD REPLACEMENT CHARACTER — stands in for the lone
 * surrogate JS would produce when charAt/slice split an astral pair. */
#define SCR_REPLACEMENT "\xEF\xBF\xBD"
#define SCR_REPLACEMENT_LEN ((size_t)3)

/* Byte length of the well-formed UTF-8 sequence starting at lead byte c. */
static size_t scr_utf8_seq_len(unsigned char c) {
  if (c < 0x80) return 1;
  if (c < 0xE0) return 2;
  if (c < 0xF0) return 3;
  return 4;
}

/* Decode the code point at p (well-formed UTF-8); *adv gets the byte
 * length of the sequence. */
static uint32_t scr_utf8_decode(const char *p, size_t *adv) {
  unsigned char c = (unsigned char)p[0];
  if (c < 0x80) {
    *adv = 1;
    return c;
  }
  if (c < 0xE0) {
    *adv = 2;
    return ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)p[1] & 0x3F);
  }
  if (c < 0xF0) {
    *adv = 3;
    return ((uint32_t)(c & 0x0F) << 12) |
           ((uint32_t)((unsigned char)p[1] & 0x3F) << 6) |
           ((unsigned char)p[2] & 0x3F);
  }
  *adv = 4;
  return ((uint32_t)(c & 0x07) << 18) |
         ((uint32_t)((unsigned char)p[1] & 0x3F) << 12) |
         ((uint32_t)((unsigned char)p[2] & 0x3F) << 6) |
         ((unsigned char)p[3] & 0x3F);
}

/* Number of UTF-16 code units in a valid UTF-8 span (BMP char = 1, astral
 * char = 2). Byte classification is position-independent, so sparse-index
 * construction can count one checkpoint interval at a time without giving
 * up the word-at-a-time length fast path. */
static size_t scr_utf16_units_span(const char *data, size_t len,
                                   bool *all_ascii) {
  const unsigned char *d = (const unsigned char *)data;
  const uint64_t hibits = 0x8080808080808080ull;
  size_t units = 0, i = 0;
  bool ascii = true;
  while (i + 8 <= len) {
    uint64_t w;
    memcpy(&w, d + i, 8);
    i += 8;
    if ((w & hibits) == 0) { /* all ASCII */
      units += 8;
      continue;
    }
    ascii = false;
    uint64_t cont = w & ~(w << 1) & hibits;
    uint64_t lead4 = w & (w << 1) & (w << 2) & (w << 3) & hibits;
    units += 8 - (size_t)__builtin_popcountll(cont) +
             (size_t)__builtin_popcountll(lead4);
  }
  while (i < len) {
    unsigned char c = d[i++];
    if ((c & 0xC0) == 0x80) continue;  /* continuation byte */
    if (c >= 0x80) ascii = false;
    units += c >= 0xF0 ? 2 : 1;
  }
  if (all_ascii) *all_ascii = ascii;
  return units;
}

/* Keep a start anchor, every stride crossed, and an exact final/prefix
 * anchor. All calls arrive at character boundaries. Returning false simply
 * means allocation failed and the hot cursor should handle this string. */
static bool scr_sidx_add_point(ScrSidx *e, size_t cu, size_t cb,
                               bool force) {
  if (e->no_more_points) return false;
  if (e->npoints != 0) {
    ScrSidxPoint last = e->points[e->npoints - 1];
    if (last.cb == cb) return true;
    if (!force && cb - last.cb < SCR_SIDX_STRIDE_BYTES) return true;
  }
  if (e->npoints == e->cap) {
    size_t cap = e->cap == 0 ? 16 : e->cap;
    if (e->cap != 0) {
      if (cap > SIZE_MAX / 2) {
        e->no_more_points = true;
        return false;
      }
      cap *= 2;
    }
    if (cap > SIZE_MAX / sizeof(*e->points)) {
      e->no_more_points = true;
      return false;
    }
    ScrSidxPoint *points = realloc(e->points, cap * sizeof(*points));
    if (!points) {
      e->no_more_points = true;
      return false;
    }
    e->points = points;
    e->cap = cap;
    scr_sidx_register_cleanup();
  }
  e->points[e->npoints++] = (ScrSidxPoint){cu, cb};
  return true;
}

/* Enable sparse state only where a 16-byte checkpoint buffer is a much
 * better trade than repeatedly walking a short string. If a completed
 * ASCII scan later proves identity mapping, all of this storage is freed. */
static bool scr_sidx_prepare_points(const ScrStr *s, ScrSidx *e) {
  if (s->len < SCR_SIDX_MIN_BYTES || e->no_more_points) return false;
  if (e->npoints == 0) {
    if (!scr_sidx_add_point(e, 0, 0, true)) return false;
    /* concat may have left an exact old end/frontier without a previous
     * buffer (notably an all-ASCII prefix). Backfill that known identity
     * span arithmetically — never rescan it just to create anchors. Exact
     * identity means every stride is also a UTF-16/code-point boundary. */
    if (e->indexed_cb != 0 && e->indexed_cb == e->indexed_cu) {
      for (size_t at = SCR_SIDX_STRIDE_BYTES; at < e->indexed_cb;) {
        if (!scr_sidx_add_point(e, at, at, true)) return false;
        if (at > e->indexed_cb - SCR_SIDX_STRIDE_BYTES) break;
        at += SCR_SIDX_STRIDE_BYTES;
      }
    }
    if (e->indexed_cb != 0 &&
        !scr_sidx_add_point(e, e->indexed_cu, e->indexed_cb, true)) {
      return false;
    }
  }
  return true;
}

/* The first code-point boundary at or after cb + SCR_SIDX_STRIDE_BYTES. */
static size_t scr_sidx_next_boundary(const ScrStr *s, size_t cb) {
  size_t remain = s->len - cb;
  size_t end = cb + (remain < SCR_SIDX_STRIDE_BYTES
                         ? remain : SCR_SIDX_STRIDE_BYTES);
  while (end < s->len && ((unsigned char)s->data[end] & 0xC0) == 0x80) end++;
  return end;
}

/* Extend the exact prefix frontier by one sparse interval. The span helper
 * retains the old length throughput; the resulting point is always a real
 * UTF-8 character boundary. */
static bool scr_sidx_extend_one(const ScrStr *s, ScrSidx *e) {
  if (e->indexed_cb == s->len) return false;
  size_t end = scr_sidx_next_boundary(s, e->indexed_cb);
  bool ascii;
  size_t units = scr_utf16_units_span(s->data + e->indexed_cb,
                                      end - e->indexed_cb, &ascii);
  /* Defer metadata until a large string proves it needs UTF-8 navigation.
   * A long ASCII prefix is already an exact identity map; when this is the
   * first mixed interval, prepare_points backfills that prefix arithmetically
   * before it is ever rescanned. */
  if (ascii && e->npoints == 0 && !e->no_more_points) {
    e->indexed_cu += units;
    e->indexed_cb = end;
    return true;
  }
  if (e->npoints == 0) (void)scr_sidx_prepare_points(s, e);
  e->indexed_cu += units;
  e->indexed_cb = end;
  if (e->npoints != 0) (void)scr_sidx_add_point(e, e->indexed_cu,
                                                  e->indexed_cb, true);
  return true;
}

/* A formerly small mixed string can cross the sparse-index threshold through
 * an ASCII in-place append. Its exact prefix already covers the whole new
 * string, so the ordinary extension path has no non-ASCII interval that
 * would cause prepare_points() to allocate anchors. Rebuild once in that
 * narrow transition instead of leaving a threshold-sized non-ASCII string
 * with only the hot cursor. This is still fail-open: an allocation failure
 * leaves the completed length/cursor cache fully usable. */
static void scr_sidx_rebuild_points(const ScrStr *s, ScrSidx *e) {
  if (s->len < SCR_SIDX_MIN_BYTES || e->npoints != 0 || e->no_more_points)
    return;
  size_t cu = 0, cb = 0;
  if (!scr_sidx_add_point(e, cu, cb, true)) return;
  while (cb < s->len) {
    size_t end = scr_sidx_next_boundary(s, cb);
    cu += scr_utf16_units_span(s->data + cb, end - cb, NULL);
    cb = end;
    if (!scr_sidx_add_point(e, cu, cb, true)) return;
  }
}

static void scr_sidx_finish(const ScrStr *s, ScrSidx *e) {
  if (e->indexed_cb != s->len) return;
  e->u16len = e->indexed_cu;
  if (e->u16len == s->len) { /* proven all ASCII: identity needs no index */
    free(e->points);
    e->points = NULL;
    e->npoints = 0;
    e->cap = 0;
  } else {
    scr_sidx_rebuild_points(s, e);
  }
}

/* Index complete 4 KiB spans until the requested unit lies inside the
 * indexed prefix. It deliberately completes that interval: a lookup just
 * before an anchor and the next distant lookup both reuse the same work. */
static void scr_sidx_extend_to_u16(const ScrStr *s, ScrSidx *e, size_t u16) {
  if (u16 <= e->indexed_cu) return;
  while (e->indexed_cb < s->len) {
    size_t start_cu = e->indexed_cu;
    scr_sidx_extend_one(s, e);
    if (u16 <= e->indexed_cu || e->indexed_cu == start_cu) break;
  }
  scr_sidx_finish(s, e);
}

/* A large, not-yet-complete string can have a long proven-ASCII prefix
 * before its first non-ASCII byte. That prefix is an exact identity map, but
 * merely advancing indexed_{cu,cb} through it leaves alternating on-demand
 * lookups with only the hot cursor and therefore linear backtracks. Once an
 * indexed conversion reaches such a prefix, retain its arithmetic stride
 * anchors too. A later full scan still drops them if the whole string proves
 * ASCII, so the all-ASCII steady state remains the allocation-free identity
 * fast path. */
static void scr_sidx_materialize_identity_prefix(const ScrStr *s, ScrSidx *e) {
  if (e->npoints == 0 && e->indexed_cb != 0 &&
      e->indexed_cb == e->indexed_cu) {
    (void)scr_sidx_prepare_points(s, e);
  }
}

/* Cached UTF-16 length. Large strings extend from their exact previously
 * indexed prefix, retaining sparse start/end anchors; short strings keep the
 * historical single word-wise scan. `u16len == byte len` proves ASCII and
 * restores identity mapping with zero retained checkpoint memory. */
static size_t scr_sidx_len(const ScrStr *s, ScrSidx *e) {
  if (e->u16len != SCR_U16_UNKNOWN) return e->u16len;
  while (e->indexed_cb < s->len) scr_sidx_extend_one(s, e);
  scr_sidx_finish(s, e);
  return e->u16len;
}

/* Step the cursor back one char (cb must be > 0 and on a boundary). */
static void scr_sidx_back(const ScrStr *s, size_t *cu, size_t *cb) {
  SCR_SIDX_STEP();
  size_t p = *cb - 1;
  while (p > 0 && ((unsigned char)s->data[p] & 0xC0) == 0x80) p--;
  *cu -= scr_utf8_seq_len((unsigned char)s->data[p]) == 4 ? 2 : 1;
  *cb = p;
}

static size_t scr_sidx_abs_diff(size_t a, size_t b) {
  return a < b ? b - a : a - b;
}

/* Pick the nearest known UTF-16 anchor. The sparse list is ordered both by
 * unit and byte, so the predecessor/successor binary-search candidates are
 * sufficient; the hot cursor retains sequential-access locality. */
static ScrSidxPoint scr_sidx_near_u16(const ScrStr *s, const ScrSidx *e,
                                      size_t u16) {
  ScrSidxPoint best = {0, 0};
  size_t best_dist = u16;
  if (e->npoints != 0) {
    size_t lo = 0, hi = e->npoints;
    while (lo < hi) {
      size_t m = lo + (hi - lo) / 2;
      if (e->points[m].cu < u16) lo = m + 1;
      else hi = m;
    }
    if (lo < e->npoints &&
        scr_sidx_abs_diff(e->points[lo].cu, u16) < best_dist) {
      best = e->points[lo];
      best_dist = scr_sidx_abs_diff(best.cu, u16);
    }
    if (lo != 0 &&
        scr_sidx_abs_diff(e->points[lo - 1].cu, u16) < best_dist) {
      best = e->points[lo - 1];
      best_dist = scr_sidx_abs_diff(best.cu, u16);
    }
  }
  if (e->cb <= s->len && scr_sidx_abs_diff(e->cu, u16) < best_dist) {
    best = (ScrSidxPoint){e->cu, e->cb};
    best_dist = scr_sidx_abs_diff(best.cu, u16);
  }
  if (e->u16len != SCR_U16_UNKNOWN &&
      scr_sidx_abs_diff(e->u16len, u16) < best_dist) {
    best = (ScrSidxPoint){e->u16len, s->len};
  }
  return best;
}

static ScrSidxPoint scr_sidx_near_byte(const ScrStr *s, const ScrSidx *e,
                                       size_t byte_off) {
  ScrSidxPoint best = {0, 0};
  size_t best_dist = byte_off;
  if (e->npoints != 0) {
    size_t lo = 0, hi = e->npoints;
    while (lo < hi) {
      size_t m = lo + (hi - lo) / 2;
      if (e->points[m].cb < byte_off) lo = m + 1;
      else hi = m;
    }
    if (lo < e->npoints &&
        scr_sidx_abs_diff(e->points[lo].cb, byte_off) < best_dist) {
      best = e->points[lo];
      best_dist = scr_sidx_abs_diff(best.cb, byte_off);
    }
    if (lo != 0 &&
        scr_sidx_abs_diff(e->points[lo - 1].cb, byte_off) < best_dist) {
      best = e->points[lo - 1];
      best_dist = scr_sidx_abs_diff(best.cb, byte_off);
    }
  }
  if (e->cb <= s->len && scr_sidx_abs_diff(e->cb, byte_off) < best_dist) {
    best = (ScrSidxPoint){e->cu, e->cb};
    best_dist = scr_sidx_abs_diff(best.cb, byte_off);
  }
  if (e->u16len != SCR_U16_UNKNOWN &&
      scr_sidx_abs_diff(s->len, byte_off) < best_dist) {
    best = (ScrSidxPoint){e->u16len, s->len};
  }
  return best;
}

/* Convert a UTF-16 index to a byte offset from the closest sparse anchor or
 * hot cursor. If u16 addresses the second (low-surrogate) unit of
 * an astral char, *mid is set and the returned offset is the START of that
 * 4-byte sequence. u16 at or past the end returns s->len with *mid false.
 * Same contract as a from-scratch scan. */
static size_t scr_u16_to_byte_c(const ScrStr *s, ScrSidx *e, size_t u16,
                                 bool *mid) {
  if (e->u16len == s->len) { /* all ASCII: identity mapping */
    *mid = false;
    return u16 < s->len ? u16 : s->len;
  }
  scr_sidx_extend_to_u16(s, e, u16);
  /* Extending a far-end lookup can just have proved identity. Do not
   * materialize an index that the identity fast path will never consult. */
  if (e->u16len == s->len) {
    *mid = false;
    return u16 < s->len ? u16 : s->len;
  }
  scr_sidx_materialize_identity_prefix(s, e);
  ScrSidxPoint near = scr_sidx_near_u16(s, e, u16);
  size_t cu = near.cu, cb = near.cb;
  while (cu > u16) scr_sidx_back(s, &cu, &cb);
  bool m = false;
  while (cu < u16 && cb < s->len) {
    SCR_SIDX_STEP();
    size_t seq = scr_utf8_seq_len((unsigned char)s->data[cb]);
    size_t w = seq == 4 ? 2 : 1;
    if (cu + w > u16) { /* u16 lands between the halves of an astral char */
      m = true;
      break;
    }
    cu += w;
    cb += seq;
  }
  e->cu = cu;
  e->cb = cb;
  *mid = m;
  return cb;
}

/* Convert a byte offset (must be a char boundary) to a UTF-16 index from
 * the closest sparse anchor or hot cursor. */
static size_t scr_byte_to_u16_c(const ScrStr *s, ScrSidx *e,
                                 size_t byte_off) {
  if (e->u16len == s->len) return byte_off; /* all ASCII */
  /* A byte search result may be far beyond the existing prefix. Build the
   * same sparse intervals first, then choose the closest boundary anchor. */
  if (byte_off > e->indexed_cb) {
    while (e->indexed_cb < byte_off) scr_sidx_extend_one(s, e);
    scr_sidx_finish(s, e);
  }
  /* As above, a completed all-ASCII scan is its own index. In particular,
   * do not rebuild points that scr_sidx_finish() deliberately discarded. */
  if (e->u16len == s->len) return byte_off;
  scr_sidx_materialize_identity_prefix(s, e);
  ScrSidxPoint near = scr_sidx_near_byte(s, e, byte_off);
  size_t cu = near.cu, cb = near.cb;
  while (cb > byte_off) scr_sidx_back(s, &cu, &cb);
  while (cb < byte_off) {
    SCR_SIDX_STEP();
    size_t seq = scr_utf8_seq_len((unsigned char)s->data[cb]);
    cu += seq == 4 ? 2 : 1;
    cb += seq;
  }
  e->cu = cu;
  e->cb = cb;
  return cu;
}

/* ECMA-262 ToIntegerOrInfinity for a double already known to be a Number:
 * NaN → +0, otherwise truncate toward zero, ±Infinity preserved. */
static double scr_to_integer_or_infinity(double x) {
  if (isnan(x)) return 0.0;
  return trunc(x);
}

/* Naive byte substring search (needle and hay are both well-formed UTF-8,
 * so any byte-level match starts on a char boundary — UTF-8 is
 * self-synchronizing). Empty needle matches at hay. */
static const char *scr_byte_find(const char *hay, size_t hay_len,
                                  const char *nee, size_t nee_len) {
  if (nee_len == 0) return hay;
  if (nee_len > hay_len) return NULL;
  for (size_t i = 0; i + nee_len <= hay_len; i++) {
    if (hay[i] == nee[0] && memcmp(hay + i, nee, nee_len) == 0)
      return hay + i;
  }
  return NULL;
}

/* lastIndexOf(needle), the one-argument form: last occurrence as a UTF-16
 * index, -1 when absent; the empty needle finds the length. A byte-wise
 * reverse scan is boundary-safe because a well-formed needle's first byte
 * is never a continuation byte. Its result routes through the same sparse
 * byte→unit mapper as indexOf rather than re-counting the whole prefix. */
double scr_str_last_index_of(ScrStr *s, ScrStr *needle) {
  ScrSidx *e = scr_sidx(s);
  if (needle->len == 0) return (double)scr_sidx_len(s, e);
  if (needle->len > s->len) return -1.0;
  for (size_t i = s->len - needle->len + 1; i-- > 0;) {
    if (memcmp(s->data + i, needle->data, needle->len) == 0) {
      return (double)scr_byte_to_u16_c(s, e, i);
    }
  }
  return -1.0;
}

double scr_str_utf16_len(ScrStr *s) {
  return (double)scr_sidx_len(s, scr_sidx(s));
}

double scr_str_char_code_at(ScrStr *s, double i) {
  double idx = scr_to_integer_or_infinity(i);
  if (!(idx >= 0)) return NAN; /* negative or -Infinity */
  /* UTF-16 length <= byte length always, so this also fences the cast. */
  if (idx >= (double)s->len) return NAN;
  ScrSidx *e = scr_sidx(s);
  if (e->u16len == s->len) return (double)(unsigned char)s->data[(size_t)idx];
  bool mid;
  size_t off = scr_u16_to_byte_c(s, e, (size_t)idx, &mid);
  if (off >= s->len) return NAN; /* idx >= length */
  size_t adv;
  uint32_t cp = scr_utf8_decode(s->data + off, &adv);
  if (cp < 0x10000) return (double)cp;
  uint32_t v = cp - 0x10000;
  return mid ? (double)(0xDC00 + (v & 0x3FF)) : (double)(0xD800 + (v >> 10));
}

double scr_str_index_of(ScrStr *s, ScrStr *needle, double fromIndex) {
  double pos = scr_to_integer_or_infinity(fromIndex);
  ScrSidx *e = scr_sidx(s);
  size_t len16 = scr_sidx_len(s, e);
  size_t start16 = pos <= 0             ? 0
                   : pos >= (double)len16 ? len16
                                          : (size_t)pos;
  /* Per spec, the empty needle is found at the clamped fromIndex itself —
   * even when that index is between the halves of an astral pair. */
  if (needle->len == 0) return (double)start16;
  bool mid;
  size_t start_b = scr_u16_to_byte_c(s, e, start16, &mid);
  /* A match can't begin on a low-surrogate half (needles are well-formed),
   * so resume at the next char boundary. */
  if (mid) start_b += 4;
  const char *found =
      scr_byte_find(s->data + start_b, s->len - start_b, needle->data,
                     needle->len);
  if (!found) return -1.0;
  return (double)scr_byte_to_u16_c(s, e, (size_t)(found - s->data));
}

/* substring: slice's clamp-and-swap sibling — ToIntegerOrInfinity both
 * boundaries (NaN → 0), clamp each to [0, len16] (negatives clamp to 0,
 * NOT relative like slice's), swap when start > end, then extract exactly
 * like slice (whose relative/negative handling is inert on the
 * already-clamped values — delegation is exact). */
ScrStr *scr_str_substring(ScrStr *s, double start, double end) {
  ScrSidx *e = scr_sidx(s);
  double len16 = (double)scr_sidx_len(s, e);
  double a = scr_to_integer_or_infinity(start);
  double b = scr_to_integer_or_infinity(end);
  double fa = a < 0 ? 0 : a > len16 ? len16 : a;
  double fb = b < 0 ? 0 : b > len16 ? len16 : b;
  return fa < fb ? scr_str_slice(s, fa, fb) : scr_str_slice(s, fb, fa);
}

bool scr_str_includes(ScrStr *s, ScrStr *needle) {
  return scr_byte_find(s->data, s->len, needle->data, needle->len) != NULL;
}

bool scr_str_starts_with(ScrStr *s, ScrStr *needle) {
  return needle->len <= s->len &&
         memcmp(s->data, needle->data, needle->len) == 0;
}

bool scr_str_ends_with(ScrStr *s, ScrStr *needle) {
  return needle->len <= s->len &&
         memcmp(s->data + (s->len - needle->len), needle->data,
                needle->len) == 0;
}

/* Resolve one slice() boundary: negatives are relative to the end, then
 * clamp to [0, len16]. Handles ±Infinity (already through
 * ToIntegerOrInfinity). */
static size_t scr_slice_boundary(double v, size_t len16) {
  if (v < 0) {
    double t = v + (double)len16; /* -Infinity stays -Infinity */
    return t <= 0 ? 0 : (size_t)t;
  }
  return v >= (double)len16 ? len16 : (size_t)v;
}

ScrStr *scr_str_slice(ScrStr *s, double start, double end) {
  ScrSidx *e = scr_sidx(s);
  size_t len16 = scr_sidx_len(s, e);
  size_t from = scr_slice_boundary(scr_to_integer_or_infinity(start), len16);
  size_t to = scr_slice_boundary(scr_to_integer_or_infinity(end), len16);
  if (from >= to) return scr_str_empty();

  bool from_mid, to_mid;
  size_t from_b = scr_u16_to_byte_c(s, e, from, &from_mid);
  size_t to_b = scr_u16_to_byte_c(s, e, to, &to_mid);
  /* Both *_mid offsets point at the start of the split astral char; the
   * kept content is the whole chars strictly inside the boundaries. */
  size_t content_b = from_mid ? from_b + 4 : from_b;
  size_t content_len = to_b - content_b;

  if (!from_mid && !to_mid)
    return scr_str_from_span(s->data + from_b, content_len);

  /* Divergence: JS would emit the lone surrogate half; we emit U+FFFD. */
  size_t total = content_len + (from_mid ? SCR_REPLACEMENT_LEN : 0) +
                 (to_mid ? SCR_REPLACEMENT_LEN : 0);
  char *tmp = malloc(total);
  if (!tmp) scr_oom();
  size_t o = 0;
  if (from_mid) {
    memcpy(tmp + o, SCR_REPLACEMENT, SCR_REPLACEMENT_LEN);
    o += SCR_REPLACEMENT_LEN;
  }
  memcpy(tmp + o, s->data + content_b, content_len);
  o += content_len;
  if (to_mid) memcpy(tmp + o, SCR_REPLACEMENT, SCR_REPLACEMENT_LEN);
  ScrStr *r = scr_str_new(tmp, total);
  free(tmp);
  return r;
}

ScrStr *scr_str_repeat(ScrStr *s, double count) {
  double n = scr_to_integer_or_infinity(count);
  if (n < 0 || (isinf(n) && n > 0)) {
    scr_trap("scriptc: RangeError: Invalid count value\n");
  }
  if (n == 0 || s->len == 0) return scr_str_empty();
  /* n is a finite non-negative integer here. Reject sizes malloc could not
   * satisfy anyway before the double→size_t conversion can overflow. */
  if (n > (double)((SIZE_MAX - sizeof(ScrStr) - 1) / s->len)) scr_oom();
  size_t total = (size_t)n * s->len;
  ScrStr *r = scr_str_alloc(total, total);
  memcpy(r->data, s->data, s->len);
  size_t filled = s->len;
  while (filled < total) { /* doubling fill */
    size_t chunk = filled <= total - filled ? filled : total - filled;
    memcpy(r->data + filled, r->data, chunk);
    filled += chunk;
  }
  r->data[total] = '\0';
  return r;
}

/* Exact ECMA-262 WhiteSpace ∪ LineTerminator membership. */
static bool scr_is_js_whitespace(uint32_t cp) {
  switch (cp) {
    case 0x0009: case 0x000A: case 0x000B: case 0x000C: case 0x000D:
    case 0x0020: case 0x00A0: case 0x1680: case 0x2028: case 0x2029:
    case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
      return true;
    default:
      return cp >= 0x2000 && cp <= 0x200A;
  }
}

ScrStr *scr_str_trim(ScrStr *s) {
  size_t b = 0, e = s->len;
  while (b < e) {
    size_t adv;
    uint32_t cp = scr_utf8_decode(s->data + b, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    b += adv;
  }
  while (e > b) {
    size_t cs = e - 1; /* back up to the lead byte of the last char */
    while (cs > b && ((unsigned char)s->data[cs] & 0xC0) == 0x80) cs--;
    size_t adv;
    uint32_t cp = scr_utf8_decode(s->data + cs, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    e = cs;
  }
  return scr_str_from_span(s->data + b, e - b);
}

ScrStr *scr_str_char_at(ScrStr *s, double i) {
  double idx = scr_to_integer_or_infinity(i);
  if (!(idx >= 0)) return scr_str_empty();
  if (idx >= (double)s->len) return scr_str_empty(); /* len16 <= len */
  ScrSidx *e = scr_sidx(s);
  if (e->u16len == s->len) { /* all ASCII */
    return (ScrStr *)&scr_ascii1[(unsigned char)s->data[(size_t)idx]];
  }
  bool mid;
  size_t off = scr_u16_to_byte_c(s, e, (size_t)idx, &mid);
  if (off >= s->len) return scr_str_empty(); /* out of range */
  size_t adv;
  uint32_t cp = scr_utf8_decode(s->data + off, &adv);
  if (cp >= 0x10000) {
    /* Divergence: JS returns the lone surrogate half; we return U+FFFD. */
    return scr_str_new(SCR_REPLACEMENT, SCR_REPLACEMENT_LEN);
  }
  return scr_str_from_span(s->data + off, adv);
}

/* trimStart()/trimEnd(): the one-sided halves of trim — same exact JS
 * WhiteSpace ∪ LineTerminator set, same scan loops. */
ScrStr *scr_str_trim_start(ScrStr *s) {
  size_t b = 0;
  while (b < s->len) {
    size_t adv;
    uint32_t cp = scr_utf8_decode(s->data + b, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    b += adv;
  }
  return scr_str_from_span(s->data + b, s->len - b);
}

ScrStr *scr_str_trim_end(ScrStr *s) {
  size_t e = s->len;
  while (e > 0) {
    size_t cs = e - 1; /* back up to the lead byte of the last char */
    while (cs > 0 && ((unsigned char)s->data[cs] & 0xC0) == 0x80) cs--;
    size_t adv;
    uint32_t cp = scr_utf8_decode(s->data + cs, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    e = cs;
  }
  return scr_str_from_span(s->data, e);
}

/* Immortal U+FFFD — the divergence-2 stand-in wherever JS would produce a
 * lone surrogate (empty-separator split of an astral char, a pad fill
 * truncated mid-pair). */
static const struct { size_t rc; size_t len; size_t cap; char data[4]; }
    scr_lit_fffd = {SIZE_MAX, 3, 3, "\xEF\xBF\xBD"};

/* split(separator, limit) with a STRING separator (ECMA-262 22.1.3.23):
 * limit is ToUint32'd; zero returns [] and reaching the limit stops before
 * any later separator probes. The no-limit wrapper supplies 2^32-1.
 * an empty separator splits into single UTF-16 code units ("".split("") is
 * [] — no probe matches nothing); a non-empty separator splits on every
 * byte-level occurrence (well-formed UTF-8 is self-synchronizing, so byte
 * matches are exactly code-point matches), keeping empty pieces at the
 * ends and between adjacent separators; an empty subject with a non-empty
 * separator is [""]. Where JS's per-unit split of an astral char would
 * yield the two lone surrogate halves, each half is U+FFFD here
 * (divergence 2 — the same substitution the island's boundary marshal
 * applied). Borrows both; returns a +1 string[]. */
ScrArr *scr_str_split_limit(ScrStr *s, ScrStr *sep, double limit_num) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  uint32_t limit = scr_to_uint32(limit_num);
  if (limit == 0) return out;
  if (sep->len == 0) {
    size_t i = 0;
    while (i < s->len) {
      size_t adv;
      uint32_t cp = scr_utf8_decode(s->data + i, &adv);
      if (cp >= 0x10000) { /* two units in JS: both halves become U+FFFD */
        scr_arr_push_ref(out, scr_str_retain((ScrStr *)&scr_lit_fffd));
        if (out->len == limit) return out;
        scr_arr_push_ref(out, scr_str_retain((ScrStr *)&scr_lit_fffd));
      } else {
        scr_arr_push_ref(out, scr_str_from_span(s->data + i, adv));
      }
      if (out->len == limit) return out;
      i += adv;
    }
    return out;
  }
  size_t start = 0;
  for (;;) {
    const char *found = scr_byte_find(s->data + start, s->len - start,
                                       sep->data, sep->len);
    if (!found) break;
    size_t at = (size_t)(found - s->data);
    scr_arr_push_ref(out, scr_str_from_span(s->data + start, at - start));
    if (out->len == limit) return out;
    start = at + sep->len;
  }
  scr_arr_push_ref(out, scr_str_from_span(s->data + start, s->len - start));
  return out;
}

ScrArr *scr_str_split(ScrStr *s, ScrStr *sep) {
  return scr_str_split_limit(s, sep, 4294967295.0);
}

/* StringPad (ECMA-262 22.1.3.16/17): target length in UTF-16 units, the
 * filler built from whole repetitions of `fill` plus a truncated prefix.
 * A target at or below the length (or an empty fill) returns the receiver
 * unchanged. A truncation that would split an astral char in the fill
 * emits U+FFFD for the kept half (one unit, like the lone surrogate JS
 * keeps — divergence 2). Sizes beyond what malloc can satisfy abort (the
 * repeat() policy; JS's RangeError fires around 2^29 units). Borrows both;
 * returns +1. */
static ScrStr *scr_pad_impl(ScrStr *s, double maxLength, ScrStr *fill,
                             bool at_start) {
  double target = scr_to_integer_or_infinity(maxLength);
  ScrSidx *e = scr_sidx(s);
  size_t len16 = scr_sidx_len(s, e);
  if (!(target > (double)len16) || fill->len == 0) return scr_str_retain(s);
  /* Reject pad sizes malloc could not satisfy before the double→size_t
   * conversion can overflow (each unit is at most 3 bytes here: BMP chars
   * and the U+FFFD stand-in; astral chars are 4 bytes for 2 units). */
  if (target > (double)((SIZE_MAX - sizeof(ScrStr) - 1) / 4)) scr_oom();
  size_t pad16 = (size_t)target - len16;
  size_t fill16 = scr_sidx_len(fill, scr_sidx(fill));
  size_t reps = pad16 / fill16, rem16 = pad16 % fill16;
  /* The truncated prefix of fill: whole chars while they fit in rem16
   * units; a final astral char that doesn't fit contributes U+FFFD. */
  size_t prefix_b = 0, prefix_units = 0;
  bool prefix_fffd = false;
  while (prefix_units < rem16) {
    size_t seq = scr_utf8_seq_len((unsigned char)fill->data[prefix_b]);
    size_t w = seq == 4 ? 2 : 1;
    if (prefix_units + w > rem16) { /* astral char split by the truncation */
      prefix_fffd = true;
      prefix_units += 1;
      break;
    }
    prefix_b += seq;
    prefix_units += w;
  }
  size_t pad_b = reps * fill->len + prefix_b +
                 (prefix_fffd ? SCR_REPLACEMENT_LEN : 0);
  if (pad_b > SIZE_MAX - sizeof(ScrStr) - 1 - s->len) scr_oom();
  size_t total = s->len + pad_b;
  ScrStr *r = scr_str_alloc(total, total);
  char *w = r->data + (at_start ? 0 : s->len);
  for (size_t i = 0; i < reps; i++) {
    memcpy(w, fill->data, fill->len);
    w += fill->len;
  }
  memcpy(w, fill->data, prefix_b);
  w += prefix_b;
  if (prefix_fffd) {
    memcpy(w, SCR_REPLACEMENT, SCR_REPLACEMENT_LEN);
    w += SCR_REPLACEMENT_LEN;
  }
  memcpy(at_start ? w : r->data, s->data, s->len);
  r->data[total] = '\0';
  return r;
}

ScrStr *scr_str_pad_start(ScrStr *s, double maxLength, ScrStr *fill) {
  return scr_pad_impl(s, maxLength, fill, true);
}

ScrStr *scr_str_pad_end(ScrStr *s, double maxLength, ScrStr *fill) {
  return scr_pad_impl(s, maxLength, fill, false);
}

/* ── parseInt: ECMA-262 19.2.5, exactly ───────────────────────────────
 * Skip JS whitespace, take an optional sign, resolve the radix through
 * ToInt32 (0 → 10 with a 0x/0X hex escape; 16 also strips the prefix;
 * outside 2..36 → NaN), scan the longest digit prefix, and round the
 * EXACT mathematical value to double. The fast path accumulates in u64
 * (u64→double conversion is correctly rounded); digit strings that
 * overflow 64 bits go through a small base-2^32 bignum and round-to-
 * nearest-even on the top 53 bits, so thousand-digit inputs in any radix
 * are Node-exact, Infinity overflow included. */

static double scr_to_int32_d(double d) {
  if (!isfinite(d) || d == 0) return 0;
  double m = fmod(trunc(d), 4294967296.0);
  if (m < 0) m += 4294967296.0;
  return m >= 2147483648.0 ? m - 4294967296.0 : m;
}

static int scr_digit_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'z') return c - 'a' + 10;
  if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
  return 99;
}

/* Digit string → double (digits already validated against the radix,
 * leading zeros stripped, count >= 1). Node (V8) is the oracle, and V8 is
 * only EXACT where the spec requires it (radix 2, 4, 8, 10, 16, 32); for
 * every other radix it runs a 32-bit-chunked double accumulation whose
 * rounding error the spec explicitly permits ("mathInt may be an
 * implementation-dependent approximation"). Reproduce both behaviors
 * bit-exactly: the chunk loop for the approximate radixes, correct
 * rounding (u64 fast path, bignum beyond) for the exact ones. */
static double scr_digits_to_double(const char *p, size_t n, int radix) {
  if (radix != 10 && (radix & (radix - 1)) != 0) {
    /* V8's generic-radix loop (numbers/conversions.cc): consume the
     * longest digit run whose multiplier stays below 0xFFFFFFFF/36, then
     * fold with one double multiply-add per chunk — the rounding of each
     * fold IS the observable Node behavior. */
    const uint32_t kMaximumMultiplier = 0xFFFFFFFFu / 36u;
    double v = 0.0;
    size_t i = 0;
    bool done = false;
    do {
      uint32_t part = 0, multiplier = 1;
      for (;;) {
        if (i == n) {
          done = true;
          break;
        }
        uint32_t d = (uint32_t)scr_digit_value(p[i]);
        uint32_t m = multiplier * (uint32_t)radix;
        if (m > kMaximumMultiplier) break; /* digit starts the next chunk */
        part = part * (uint32_t)radix + d;
        multiplier = m;
        i++;
      }
      v = v * (double)multiplier + (double)part;
    } while (!done);
    return v;
  }
  /* u64 fast path: exact while the accumulator fits. */
  uint64_t acc = 0;
  size_t i = 0;
  for (; i < n; i++) {
    int dv = scr_digit_value(p[i]);
    if (acc > (UINT64_MAX - (uint64_t)dv) / (uint64_t)radix) break;
    acc = acc * (uint64_t)radix + (uint64_t)dv;
  }
  if (i == n) return (double)acc;
  /* Bignum path: base-2^32 limbs, little-endian, multiply-add per digit. */
  size_t cap = 4 + (n * 6) / 32; /* log2(36) < 6 bits per digit */
  uint32_t *limbs = malloc(cap * sizeof(uint32_t));
  if (!limbs) scr_oom();
  limbs[0] = (uint32_t)acc;
  limbs[1] = (uint32_t)(acc >> 32);
  size_t nl = limbs[1] ? 2 : 1;
  for (; i < n; i++) {
    uint64_t carry = (uint64_t)scr_digit_value(p[i]);
    for (size_t j = 0; j < nl; j++) {
      uint64_t t = (uint64_t)limbs[j] * (uint64_t)radix + carry;
      limbs[j] = (uint32_t)t;
      carry = t >> 32;
    }
    if (carry) {
      if (nl == cap) { /* unreachable by the cap bound; belt and braces */
        cap *= 2;
        limbs = realloc(limbs, cap * sizeof(uint32_t));
        if (!limbs) scr_oom();
      }
      limbs[nl++] = (uint32_t)carry;
    }
  }
  /* Round the bignum to double: top 53 bits, guard, sticky, half-even. */
  size_t topbits = 32 - (size_t)__builtin_clz(limbs[nl - 1]);
  size_t bitlen = 32 * (nl - 1) + topbits;
  /* bitlen > 64 here (the fast path overflowed), so shift > 0. */
  size_t shift = bitlen - 54; /* keep 53 mantissa bits + 1 guard bit */
  uint64_t top = 0;
  for (size_t k = 0; k < 54; k++) {
    size_t bit = shift + k;
    uint64_t b = (limbs[bit / 32] >> (bit % 32)) & 1u;
    top |= b << k;
  }
  bool sticky = false;
  for (size_t bit = 0; bit < shift && !sticky; bit++) {
    sticky = ((limbs[bit / 32] >> (bit % 32)) & 1u) != 0;
  }
  free(limbs);
  uint64_t mant = top >> 1;
  bool guard = (top & 1u) != 0;
  if (guard && (sticky || (mant & 1u))) mant++;
  int exp2 = (int)shift + 1;
  if (mant == (1ull << 53)) { /* rounding carried into a new bit */
    mant >>= 1;
    exp2++;
  }
  return ldexp((double)mant, exp2); /* overflow → HUGE_VAL, JS's Infinity */
}

double scr_parse_int(ScrStr *s, double radix) {
  double r32 = scr_to_int32_d(radix);
  const char *p = s->data;
  size_t n = s->len, i = 0;
  while (i < n) {
    size_t adv;
    uint32_t cp = scr_utf8_decode(p + i, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    i += adv;
  }
  double sign = 1.0;
  if (i < n && (p[i] == '+' || p[i] == '-')) {
    if (p[i] == '-') sign = -1.0;
    i++;
  }
  int radix_i;
  bool strip_prefix = true;
  if (r32 != 0) {
    if (r32 < 2 || r32 > 36) return NAN;
    radix_i = (int)r32;
    if (radix_i != 16) strip_prefix = false;
  } else {
    radix_i = 10;
  }
  if (strip_prefix && i + 1 < n && p[i] == '0' &&
      (p[i + 1] == 'x' || p[i + 1] == 'X')) {
    i += 2;
    radix_i = 16;
  }
  size_t dig_start = i;
  while (i < n && scr_digit_value(p[i]) < radix_i) i++;
  if (i == dig_start) return NAN;
  while (dig_start < i && p[dig_start] == '0') dig_start++;
  if (dig_start == i) return sign * 0.0; /* all zeros; "-0" is -0 */
  return sign * scr_digits_to_double(p + dig_start, i - dig_start, radix_i);
}

/* ES parseFloat (ECMA-262 StrDecimalLiteral prefix over the trimmed
 * input): skip JS whitespace, then take the LONGEST decimal-literal
 * prefix — [+-]? (Infinity | digits [. digits*] | . digits) with an
 * optional [eE][+-]?digits exponent — and answer NaN when none exists.
 * Deliberately narrower than strtod's own grammar (no hex, no
 * "inf"/"nan" spellings, "Infinity" exact-case only), so the validated
 * span is COPIED before strtod sees it — handing strtod the raw tail
 * would let it claim "0x10" as hex where JS answers 0. strtod on the
 * validated span is correctly rounded (the JSON parser's precedent). */
double scr_parse_float(ScrStr *s) {
  const char *p = s->data;
  size_t n = s->len, i = 0;
  while (i < n) {
    size_t adv;
    uint32_t cp = scr_utf8_decode(p + i, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    i += adv;
  }
  size_t start = i;
  double sign = 1.0;
  if (i < n && (p[i] == '+' || p[i] == '-')) {
    if (p[i] == '-') sign = -1.0;
    i++;
  }
  if (i + 8 <= n && memcmp(p + i, "Infinity", 8) == 0) {
    return sign * (double)INFINITY;
  }
  size_t int_digits = 0, frac_digits = 0;
  while (i < n && p[i] >= '0' && p[i] <= '9') {
    i++;
    int_digits++;
  }
  if (i < n && p[i] == '.') {
    size_t j = i + 1;
    while (j < n && p[j] >= '0' && p[j] <= '9') {
      j++;
      frac_digits++;
    }
    /* "." alone is not a literal; "1." is (trailing dot, no fraction). */
    if (int_digits > 0 || frac_digits > 0) i = j;
  }
  if (int_digits == 0 && frac_digits == 0) return NAN;
  size_t end = i;
  if (i < n && (p[i] == 'e' || p[i] == 'E')) {
    size_t j = i + 1;
    if (j < n && (p[j] == '+' || p[j] == '-')) j++;
    size_t ed = j;
    while (j < n && p[j] >= '0' && p[j] <= '9') j++;
    if (j > ed) end = j; /* exponent joins only with digits ("1e" is 1) */
  }
  size_t span = end - start;
  char buf[64];
  char *tmp = span < sizeof(buf) ? buf : malloc(span + 1);
  if (!tmp) scr_oom();
  memcpy(tmp, p + start, span);
  tmp[span] = '\0';
  double r = strtod(tmp, NULL);
  if (tmp != buf) free(tmp);
  return r;
}

/* ToNumber(string) — ECMA-262 7.1.4.1 StringToNumber, exactly. The
 * grammar (StringNumericLiteral) differs from parseFloat's in all three
 * directions: the WHOLE trimmed span must match (trailing garbage → NaN,
 * where parseFloat keeps the longest prefix), the non-decimal 0x/0o/0b
 * integer literals join (UNSIGNED only — a sign on them is NaN), and the
 * empty/whitespace-only string is +0 (parseFloat: NaN). Decimal spans
 * convert through strtod like parseFloat (copied first — strtod's own
 * grammar is wider — inheriting correct rounding, the JSON precedent);
 * 0x/0o/0b digits are the exact mathematical value rounded to nearest-
 * even via scr_digits_to_double (u64 fast path, bignum beyond 2^64 —
 * Node-exact for giant hex, Infinity overflow included: power-of-two
 * radixes take the exact path, never V8's approximate chunk loop). */
double scr_string_to_number(ScrStr *s) {
  const char *p = s->data;
  size_t b = 0, e = s->len;
  while (b < e) {
    size_t adv;
    uint32_t cp = scr_utf8_decode(p + b, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    b += adv;
  }
  while (e > b) {
    size_t cs = e - 1; /* back up to the lead byte of the last char */
    while (cs > b && ((unsigned char)p[cs] & 0xC0) == 0x80) cs--;
    size_t adv;
    uint32_t cp = scr_utf8_decode(p + cs, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    e = cs;
  }
  if (b == e) return 0.0; /* empty or all StrWhiteSpace */
  p += b;
  size_t n = e - b;
  /* NonDecimalIntegerLiteral: 0x/0X, 0o/0O, 0b/0B — no sign admitted. */
  if (n >= 2 && p[0] == '0' &&
      (p[1] == 'x' || p[1] == 'X' || p[1] == 'o' || p[1] == 'O' ||
       p[1] == 'b' || p[1] == 'B')) {
    int radix = (p[1] == 'x' || p[1] == 'X') ? 16
              : (p[1] == 'o' || p[1] == 'O') ? 8
                                             : 2;
    size_t i = 2, dig_start = 2;
    while (i < n && scr_digit_value(p[i]) < radix) i++;
    if (i == dig_start || i != n) return NAN; /* no digits, or garbage */
    while (dig_start < i && p[dig_start] == '0') dig_start++;
    if (dig_start == i) return 0.0;
    return scr_digits_to_double(p + dig_start, i - dig_start, radix);
  }
  /* StrDecimalLiteral, whole-span: [+-]? (Infinity | digits [. digits*]
   * | . digits) ([eE][+-]?digits)? — nothing before, nothing after. */
  size_t i = 0;
  double sign = 1.0;
  if (p[0] == '+' || p[0] == '-') {
    if (p[0] == '-') sign = -1.0;
    i = 1;
  }
  if (n - i == 8 && memcmp(p + i, "Infinity", 8) == 0) {
    return sign * (double)INFINITY;
  }
  size_t int_digits = 0, frac_digits = 0;
  while (i < n && p[i] >= '0' && p[i] <= '9') {
    i++;
    int_digits++;
  }
  if (i < n && p[i] == '.') {
    i++;
    while (i < n && p[i] >= '0' && p[i] <= '9') {
      i++;
      frac_digits++;
    }
  }
  if (int_digits == 0 && frac_digits == 0) return NAN; /* ".", "+", "e5" */
  if (i < n && (p[i] == 'e' || p[i] == 'E')) {
    i++;
    if (i < n && (p[i] == '+' || p[i] == '-')) i++;
    size_t ed = i;
    while (i < n && p[i] >= '0' && p[i] <= '9') i++;
    if (i == ed) return NAN; /* "1e", "1e+" — exponent needs digits */
  }
  if (i != n) return NAN; /* trailing garbage ("1_000", "1.2.3", "12px") */
  char buf[64];
  char *tmp = n < sizeof(buf) ? buf : malloc(n + 1);
  if (!tmp) scr_oom();
  memcpy(tmp, p, n);
  tmp[n] = '\0';
  double r = strtod(tmp, NULL);
  if (tmp != buf) free(tmp);
  return r;
}

ScrStr *scr_f64_to_scrstr(double x) {
  char buf[32];
  size_t len = scr_f64_to_str(x, buf);
  return scr_str_new(buf, len);
}

/* ── encodeURIComponent / encodeURI ───────────────────────────────────
 * ECMA-262 Encode() over the UTF-8 storage. The spec transcodes UTF-16
 * to UTF-8 and percent-encodes every byte outside the unescaped set —
 * storage here already IS well-formed UTF-8 (lone surrogates were
 * substituted with U+FFFD at their producers, SEMANTICS.md 2), so the
 * walk is byte-wise and the spec's URIError arm (unpaired surrogates)
 * is unreachable: the encoders are total. Unescaped sets are the
 * spec's: uriUnescaped = ALPHA / DIGIT / -_.!~*'() for
 * encodeURIComponent; encodeURI keeps uriReserved ;/?:@&=+$, and #
 * too. Hex digits are uppercase, per spec. Borrows s; result +1. */
static bool scr_uri_unescaped(unsigned char c, bool keep_reserved) {
  if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) return true;
  switch (c) {
    case '-': case '_': case '.': case '!': case '~': case '*': case '\'': case '(': case ')':
      return true;
    default:
      break;
  }
  if (!keep_reserved) return false;
  switch (c) {
    case ';': case '/': case '?': case ':': case '@': case '&': case '=':
    case '+': case '$': case ',': case '#':
      return true;
    default:
      return false;
  }
}

static ScrStr *scr_encode_uri_impl(ScrStr *s, bool keep_reserved) {
  const unsigned char *b = (const unsigned char *)s->data;
  size_t n = s->len, out_len = 0;
  for (size_t i = 0; i < n; i++) out_len += scr_uri_unescaped(b[i], keep_reserved) ? 1 : 3;
  if (out_len == n) return scr_str_retain(s); /* nothing escapes — share */
  ScrStr *out = scr_str_alloc_raw(out_len, out_len);
  static const char hex[] = "0123456789ABCDEF";
  char *w = out->data;
  for (size_t i = 0; i < n; i++) {
    if (scr_uri_unescaped(b[i], keep_reserved)) {
      *w++ = (char)b[i];
    } else {
      *w++ = '%';
      *w++ = hex[b[i] >> 4];
      *w++ = hex[b[i] & 0xF];
    }
  }
  out->len = out_len;
  out->data[out_len] = '\0';
  return out;
}

ScrStr *scr_encode_uri_component(ScrStr *s) { return scr_encode_uri_impl(s, false); }

ScrStr *scr_encode_uri(ScrStr *s) { return scr_encode_uri_impl(s, true); }

/* ── isWellFormed / toWellFormed ──────────────────────────────────────
 * Storage here IS well-formed by invariant: every producer substitutes
 * the lone surrogates JS strings could carry with U+FFFD at creation
 * (SEMANTICS.md 2), so no string this runtime can hold is ill-formed.
 * isWellFormed answers the constant the invariant guarantees and
 * toWellFormed is the identity (per spec both are no-ops on well-formed
 * input). A program whose Node run would see `false` already diverged
 * at the string's creation, not here. */
bool scr_str_is_well_formed(ScrStr *s) {
  (void)s;
  return true;
}

ScrStr *scr_str_to_well_formed(ScrStr *s) { return scr_str_retain(s); }

/* Immortal interned booleans (same layout trick the emitter uses for
 * string literals). */
static const struct { size_t rc; size_t len; size_t cap; char data[5]; }
    scr_lit_true = {SIZE_MAX, 4, 4, "true"};
static const struct { size_t rc; size_t len; size_t cap; char data[6]; }
    scr_lit_false = {SIZE_MAX, 5, 5, "false"};

ScrStr *scr_bool_to_scrstr(bool b) {
  return b ? (ScrStr *)&scr_lit_true : (ScrStr *)&scr_lit_false;
}

/* The string iterator's step (for-of over strings): the full CHARACTER at
 * UTF-16 index i — one code POINT, so an astral char comes back as its
 * whole two-unit string where charAt would truncate to U+FFFD. The
 * iterating loop advances by the result's UTF-16 length, exactly JS's
 * String[Symbol.iterator] contract. Storage is valid UTF-8 by invariant
 * (literals canonicalized lone surrogates to U+FFFD at creation), so every
 * decode is a whole char; an i addressing the LOW half of an astral pair
 * (unreachable from the iterator, which only lands on char starts) answers
 * the containing char. Out of range → empty string. Borrows s; +1. */
ScrStr *scr_str_cp_at(ScrStr *s, double i) {
  double idx = scr_to_integer_or_infinity(i);
  if (!(idx >= 0)) return scr_str_empty();
  if (idx >= (double)s->len) return scr_str_empty(); /* len16 <= len */
  ScrSidx *e = scr_sidx(s);
  if (e->u16len == s->len) { /* all ASCII */
    return (ScrStr *)&scr_ascii1[(unsigned char)s->data[(size_t)idx]];
  }
  bool mid;
  size_t off = scr_u16_to_byte_c(s, e, (size_t)idx, &mid);
  if (off >= s->len) return scr_str_empty(); /* out of range */
  size_t adv;
  (void)scr_utf8_decode(s->data + off, &adv);
  return scr_str_from_span(s->data + off, adv);
}


/* ── the URI component codecs (encodeURIComponent/decodeURIComponent) ──
 * ECMA-262 Encode/Decode with the component sets, byte-wise over the
 * runtime's UTF-8 storage: the spec percent-encodes each code point's
 * UTF-8 bytes, which over UTF-8 storage is exactly a byte scan, and
 * Decode's "octets must form a valid UTF-8 encoding" is a strict
 * validation of the assembled escape bytes (raw bytes copy through —
 * they are the already-valid encoding of code points the spec leaves
 * untouched). */

/* The component unreserved set: ALPHA / DIGIT / - _ . ! ~ * ' ( ). */
static bool scr_uri_unreserved(unsigned char c) {
  if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) return true;
  switch (c) {
    case '-': case '_': case '.': case '!': case '~':
    case '*': case '\'': case '(': case ')':
      return true;
    default:
      return false;
  }
}

ScrStr *scr_str_encode_uri_component(ScrStr *s) {
  size_t extra = 0;
  for (size_t i = 0; i < s->len; i++) {
    if (!scr_uri_unreserved((unsigned char)s->data[i])) extra += 2;
  }
  if (extra == 0) {
    scr_str_retain(s);
    return s;
  }
  static const char hex[] = "0123456789ABCDEF";
  ScrStr *out = scr_str_alloc_raw(s->len + extra, s->len + extra);
  char *w = out->data;
  for (size_t i = 0; i < s->len; i++) {
    unsigned char c = (unsigned char)s->data[i];
    if (scr_uri_unreserved(c)) {
      *w++ = (char)c;
    } else {
      *w++ = '%';
      *w++ = hex[c >> 4];
      *w++ = hex[c & 0xf];
    }
  }
  out->data[out->len] = '\0';
  return out;
}

static void scr_uri_malformed(void) {
  scr_throw_error_named(scr_str_new("URIError", 8),
                        scr_str_new("URI malformed", 13));
}

/* One %XX escape's byte, or -1 (bad hex / truncated). */
static int scr_uri_hex_byte(const char *p, size_t rem) {
  if (rem < 3 || p[0] != '%') return -1;
  int hi, lo;
  char a = p[1], b = p[2];
  if (a >= '0' && a <= '9') hi = a - '0';
  else if (a >= 'A' && a <= 'F') hi = a - 'A' + 10;
  else if (a >= 'a' && a <= 'f') hi = a - 'a' + 10;
  else return -1;
  if (b >= '0' && b <= '9') lo = b - '0';
  else if (b >= 'A' && b <= 'F') lo = b - 'A' + 10;
  else if (b >= 'a' && b <= 'f') lo = b - 'a' + 10;
  else return -1;
  return (hi << 4) | lo;
}

/* The non-throwing core of decodeURIComponent: NULL on malformed input
 * (bad hex, invalid UTF-8 octets) instead of the URIError — the
 * querystring unit's unescape needs exactly the try/catch shape Node's
 * qsUnescape wraps around decodeURIComponent (scr_qs.c), and the throwing
 * entry point below stays byte-identical by rethrowing over NULL. */
ScrStr *scr_str_decode_uri_component_try(ScrStr *s) {
  /* Decoding only ever shrinks (%XX → 1 byte), so len is a safe cap. */
  ScrStr *out = scr_str_alloc_raw(0, s->len);
  size_t w = 0;
  const char *p = s->data;
  size_t n = s->len, i = 0;
  while (i < n) {
    if (p[i] != '%') {
      out->data[w++] = p[i++];
      continue;
    }
    int b0 = scr_uri_hex_byte(p + i, n - i);
    if (b0 < 0) goto malformed;
    i += 3;
    if (b0 < 0x80) {
      /* The empty component reserved set: every ASCII escape decodes. */
      out->data[w++] = (char)b0;
      continue;
    }
    /* Multibyte: the continuation bytes must ALSO be escapes (a raw byte
     * is its own code point in the spec's string, never a continuation),
     * and the whole sequence must be strictly valid UTF-8. */
    int need;                /* continuation count */
    int lo = 0x80, hi = 0xBF; /* first continuation's tightened range */
    if (b0 >= 0xC2 && b0 <= 0xDF) need = 1;
    else if (b0 == 0xE0) { need = 2; lo = 0xA0; }
    else if (b0 == 0xED) { need = 2; hi = 0x9F; } /* no surrogates */
    else if (b0 >= 0xE1 && b0 <= 0xEF) need = 2;
    else if (b0 == 0xF0) { need = 3; lo = 0x90; }
    else if (b0 == 0xF4) { need = 3; hi = 0x8F; } /* <= U+10FFFF */
    else if (b0 >= 0xF1 && b0 <= 0xF3) need = 3;
    else goto malformed; /* 0x80..0xC1, 0xF5..0xFF: never a leading byte */
    out->data[w++] = (char)b0;
    for (int k = 0; k < need; k++) {
      int bc = scr_uri_hex_byte(p + i, n - i);
      if (bc < 0) goto malformed;
      if (k == 0 ? (bc < lo || bc > hi) : (bc < 0x80 || bc > 0xBF)) goto malformed;
      i += 3;
      out->data[w++] = (char)bc;
    }
  }
  out->len = w;
  out->data[w] = '\0';
  return out;
malformed:
  scr_str_release(out);
  return NULL;
}

ScrStr *scr_str_decode_uri_component(ScrStr *s) {
  ScrStr *out = scr_str_decode_uri_component_try(s);
  if (!out) {
    scr_uri_malformed();
    return NULL;
  }
  return out;
}
