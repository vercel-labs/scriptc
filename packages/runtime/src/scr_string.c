#include "scr_runtime.h"
#include "scr_key.h"
#include "scr_collation_data.h"

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
/* A published string is immortal: it is never freed, so it leaves the count. */
void scr_str_live_forget(void) { scr_live_strings--; }
#endif

static void scr_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* Weak, bounded interning for tiny slices (including non-ASCII characters).
 * Unlike an owning cache, this never keeps a string alive: its last release
 * removes the entry. Collisions simply replace the weak pointer. A unique
 * string can still be appended to or reallocated, so those paths invalidate
 * the entry before touching its bytes/address. No ScrStr ABI change. */
#define SCR_SHORT_N 64
static SCR_TL ScrStr *scr_short_tab[SCR_SHORT_N];

/* A 2..4-byte span packed into one word: its identity in the table. */
static inline uint32_t scr_short_word(const char *bytes, size_t len) {
  uint32_t w = (uint32_t)(unsigned char)bytes[0] | (uint32_t)(unsigned char)bytes[1] << 8;
  if (len > 2) w |= (uint32_t)(unsigned char)bytes[2] << 16;
  if (len > 3) w |= (uint32_t)(unsigned char)bytes[3] << 24;
  return w;
}

static inline size_t scr_short_slot(uint32_t word, size_t len) {
  return (size_t)(((word ^ (uint32_t)len) * UINT32_C(0x9E3779B1)) >> 26) % SCR_SHORT_N;
}

static void scr_short_forget(const ScrStr *s) {
  if (s->len < 2 || s->len > 4) return;
  size_t h = scr_short_slot(scr_short_word(s->data, s->len), s->len);
  if (scr_short_tab[h] == s) scr_short_tab[h] = NULL;
}

/* ── UTF-16 index cache ───────────────────────────────────────────────
 * JS string semantics are UTF-16 indices over our UTF-8 storage, so
 * .length, charCodeAt, charAt, indexOf and slice all need unit↔byte
 * conversions. A four-entry direct cursor cache keeps the old hot cursor for
 * tiny and allocation-failure traffic. A separate four-entry sparse cache
 * owns `{ UTF-16 unit, UTF-8 byte }` checkpoints, so a warmed non-local
 * lookup decodes at most one checkpoint interval instead of a prefix
 * proportional to its requested index.
 *
 * Checkpoints are owned by the entry, not the ScrStr ABI: the representation
 * remains the three-word UTF-8 ScrStr used by literals, FFI and generated
 * code. Checkpoints cost two size_ts every 4 KiB (about 0.39% of indexed
 * bytes). There are exactly four sparse entries per runtime instance;
 * eviction, release, realloc, executable exit, and every library reset free
 * retained metadata. The cursor and sparse tiers are deliberately separate:
 * fresh short receivers never evict a retained large-string index. This
 * fixed residency is intentional: registry lookup and the release of
 * unrelated strings never scale with the number of live indexed receivers.
 * SCR_TL makes both tables and owned buffers instance-local for
 * SCR_THREAD_INSTANCES. Metadata allocation is strictly an optimization:
 * overflow or malloc failure falls back to the cursor mapper.
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
  size_t ascii_cu, ascii_cb, ascii_end; /* bounded, proven identity span */
  ScrSidxPoint *points;  /* sparse, ordered code-point-boundary anchors */
  size_t npoints, cap;   /* owned points length/capacity */
  size_t indexed_cu;     /* exact contiguous prefix indexed from byte zero */
  size_t indexed_cb;
  bool no_more_points;   /* metadata allocation failed/overflowed: fail open */
  bool points_complete;  /* points cover every stride of indexed prefix */
  uint16_t *units;       /* the UTF-16 code units, once reads warrant them */
  size_t nunits;
  size_t reads;          /* indexed reads that missed the unit array */
} ScrSidx;
/* Keep short-string cursor traffic out of the sparse cache. A short-lived
 * one-byte receiver can be far more common than a large indexed one; sharing
 * the round-robin slots would otherwise rebuild a warm index every few calls.
 * Explicitly initialized so library localization can demote it: a tentative
 * definition is a COMMON symbol on Mach-O, and COMMON symbols stay global.
 */
SCR_TL ScrStrScan scr_str_scan = {0};
static SCR_TL ScrSidx scr_sidx_sparse_tab[SCR_SIDX_N];
static SCR_TL ScrSidx scr_sidx_cursor_tab[SCR_SIDX_N];
static SCR_TL unsigned scr_sidx_sparse_clock;
static SCR_TL unsigned scr_sidx_cursor_clock;
static SCR_TL unsigned scr_sidx_sparse_live;
static SCR_TL bool scr_sidx_cleanup_registered;
/* Counts both tiers, independent of the wrapping eviction clocks. A transfer
 * moves one active entry; only clearing or initializing changes the count. */
static SCR_TL size_t scr_sidx_active;

static void scr_sidx_clear(ScrSidx *e, unsigned *live) {
  if (e->s) {
    scr_sidx_active--;
    if (live) (*live)--;
  }
  free(e->points);
  if (e->units && scr_str_scan.units == e->units) {
    scr_str_scan.s = NULL;
    scr_str_scan.units = NULL;
    scr_str_scan.n = 0;
  }
  free(e->units);
  memset(e, 0, sizeof(*e));
}

static void scr_sidx_reset_all(void) {
  for (int i = 0; i < SCR_SIDX_N; i++) {
    scr_sidx_clear(&scr_sidx_sparse_tab[i], &scr_sidx_sparse_live);
    scr_sidx_clear(&scr_sidx_cursor_tab[i], NULL);
  }
  scr_sidx_sparse_clock = 0;
  scr_sidx_cursor_clock = 0;
}

static void scr_sidx_register_cleanup(void) {
  if (!scr_sidx_cleanup_registered) {
    scr_sidx_cleanup_registered = true;
    scr_atexit(scr_sidx_reset_all);
  }
}

#ifdef SCR_SIDX_TEST
static SCR_TL size_t scr_sidx_walk_steps;
static SCR_TL size_t scr_sidx_searches;
void scr_sidx_test_reset_steps(void) {
  scr_sidx_walk_steps = 0;
  scr_sidx_searches = 0;
}
size_t scr_sidx_test_walk_steps(void) { return scr_sidx_walk_steps; }
size_t scr_sidx_test_searches(void) { return scr_sidx_searches; }
void scr_sidx_test_reset_cache(void) { scr_sidx_reset_all(); }
size_t scr_sidx_test_active(void) { return scr_sidx_active; }
size_t scr_sidx_test_entries(void) {
  size_t n = 0;
  for (int i = 0; i < SCR_SIDX_N; i++)
    n += scr_sidx_sparse_tab[i].s != NULL;
  return n;
}
size_t scr_sidx_test_points(void) {
  size_t n = 0;
  for (int i = 0; i < SCR_SIDX_N; i++)
    n += scr_sidx_sparse_tab[i].npoints;
  return n;
}
#define SCR_SIDX_STEP() (scr_sidx_walk_steps++)
#define SCR_SIDX_SEARCH() (scr_sidx_searches++)
#else
#define SCR_SIDX_STEP() ((void)0)
#define SCR_SIDX_SEARCH() ((void)0)
#endif

/* Share cleanup across release and scratch reuse; callers inline only the
 * empty-cache check. */
static __attribute__((noinline)) void scr_sidx_purge_active(const ScrStr *s) {
  /* These are deliberately fixed four-entry tables, never an unbounded
   * receiver registry. Releasing an unrelated temporary therefore does at
   * most eight pointer comparisons and cannot grow with live strings. */
  for (int i = 0; i < SCR_SIDX_N; i++) {
    if (scr_sidx_sparse_tab[i].s == s)
      scr_sidx_clear(&scr_sidx_sparse_tab[i], &scr_sidx_sparse_live);
    if (scr_sidx_cursor_tab[i].s == s)
      scr_sidx_clear(&scr_sidx_cursor_tab[i], NULL);
  }
}

static void scr_sidx_purge(const ScrStr *s) {
  if (scr_sidx_active) scr_sidx_purge_active(s);
}

static void scr_sidx_init(ScrSidx *e, const ScrStr *s, unsigned *live) {
  memset(e, 0, sizeof(*e));
  e->s = s;
  scr_sidx_active++;
  if (live) (*live)++;
  e->u16len = SCR_U16_UNKNOWN;
}

/* Reuse sparse-tier holes left by short-lived receivers before evicting a live index.
 * Round-robin eviction remains bounded when every slot is occupied. */
static ScrSidx *scr_sidx_claim(ScrSidx *table, unsigned *clock, unsigned *live) {
  /* A full tier needs no second slot scan after the failed lookup. */
  for (size_t offset = 0; *live < SCR_SIDX_N && offset < SCR_SIDX_N; offset++) {
    size_t index = (*clock + offset) % SCR_SIDX_N;
    if (!table[index].s) {
      *clock = (unsigned)(index + 1);
      return &table[index];
    }
  }
  ScrSidx *entry = &table[(*clock)++ % SCR_SIDX_N];
  scr_sidx_clear(entry, live);
  return entry;
}

/* Short strings retain the historical hot cursor without contending with the
 * sparse residency. Large strings claim only the sparse tier; an in-place
 * append that crosses the threshold moves its exact cursor frontier into
 * that tier rather than scanning the unchanged prefix again. All-ASCII
 * receivers still shed their point buffer after proving identity mapping.
 * Both tiers remain fixed-size and allocation-free until a non-ASCII sparse
 * receiver actually needs checkpoints. */
static SCR_TL ScrSidx *scr_sidx_last; /* most recent hit; a slot, never freed */

static ScrSidx *scr_sidx_lookup(const ScrStr *s) {
  if (s->len >= SCR_SIDX_MIN_BYTES) {
    for (int i = 0; i < SCR_SIDX_N; i++) {
      if (scr_sidx_sparse_tab[i].s == s) return &scr_sidx_sparse_tab[i];
    }
    /* The only in-place mutation is append. A formerly short receiver can
     * therefore cross the threshold with an exact, useful cursor frontier
     * already in the cursor tier; transfer it before evicting a sparse slot.
     * No checkpoint buffer can exist below the threshold, but moving the
     * whole record also preserves the fail-open allocation state. */
    for (int i = 0; i < SCR_SIDX_N; i++) {
      ScrSidx *old = &scr_sidx_cursor_tab[i];
      if (old->s != s) continue;
      ScrSidx *e = scr_sidx_claim(scr_sidx_sparse_tab, &scr_sidx_sparse_clock, &scr_sidx_sparse_live);
      *e = *old;
      scr_sidx_sparse_live++;
      memset(old, 0, sizeof(*old)); /* ownership moved to the sparse tier */
      return e;
    }
    ScrSidx *e = scr_sidx_claim(scr_sidx_sparse_tab, &scr_sidx_sparse_clock, &scr_sidx_sparse_live);
    scr_sidx_init(e, s, &scr_sidx_sparse_live);
    return e;
  }
  ScrSidx *tab = scr_sidx_cursor_tab;
  unsigned *clock = &scr_sidx_cursor_clock;
  for (int i = 0; i < SCR_SIDX_N; i++) {
    if (tab[i].s == s) return &tab[i];
  }
  ScrSidx *e = &tab[(*clock)++ % SCR_SIDX_N];
  scr_sidx_clear(e, NULL);
  scr_sidx_init(e, s, NULL);
  return e;
}

/* Sequential reads of one receiver (a scan over a source text) hit the
 * same entry call after call. The memo is a pointer to a static slot, so a
 * cleared, moved or reassigned entry simply fails the owner test. */
static ScrSidx *scr_sidx(const ScrStr *s) {
  ScrSidx *last = scr_sidx_last;
  /* An in-place append can carry a cursor-tier receiver across the sparse
   * threshold; only the lookup performs that transfer, so the memo must
   * also match the receiver's current tier. */
  bool sparse = (uintptr_t)last - (uintptr_t)scr_sidx_sparse_tab < sizeof scr_sidx_sparse_tab;
  if (last && last->s == s && sparse == (s->len >= SCR_SIDX_MIN_BYTES)) return last;
  return scr_sidx_last = scr_sidx_lookup(s);
}

/* The index entry for a receiver that is not proven ASCII, or NULL when it
 * is: proven-ASCII strings map units to bytes by identity, and every mapper
 * below checks the header bit before touching the entry. The bit only ever
 * turns on during a read, so "ascii or entry" holds for the whole call. */
static ScrSidx *scr_sidx_for(const ScrStr *s) {
  return s->ascii ? NULL : scr_sidx(s);
}

/* In-place concat changes only the suffix. Keep every exact prefix anchor
 * (including the former end, which is now an ordinary boundary), but remove
 * the sole fact that described the old complete string. A threshold-crossing
 * receiver may move from the cursor tier to the sparse tier on its next
 * lookup, so invalidate either possible entry. */
static void scr_sidx_concat_append(const ScrStr *s, size_t oldlen) {
  if (scr_sidx_active == 0) return;
  for (int i = 0; i < SCR_SIDX_N; i++) {
    ScrSidx *entries[] = {&scr_sidx_sparse_tab[i], &scr_sidx_cursor_tab[i]};
    for (size_t j = 0; j < sizeof(entries) / sizeof(entries[0]); j++) {
      ScrSidx *e = entries[j];
      if (e->s != s) continue;
      e->u16len = SCR_U16_UNKNOWN;
      if (e->indexed_cb > oldlen) e->indexed_cb = oldlen;
      if (e->units && scr_str_scan.units == e->units) {
        scr_str_scan.s = NULL;
        scr_str_scan.units = NULL;
        scr_str_scan.n = 0;
      }
      free(e->units); /* the units describe the old content */
      e->units = NULL;
      e->nunits = 0;
      e->reads = 0;
    }
  }
}

/* ── allocation ─────────────────────────────────────────────────────── */

static ScrStr *scr_str_alloc(size_t len, size_t cap) {
  if (len > cap || cap > SCR_STR_MAX_CAP) scr_oom();
  ScrStr *s = scr_mem_alloc(sizeof(ScrStr) + cap + 1);
  if (!s) scr_oom();
  s->rc = 1;
  s->len = len;
  s->cap = cap;
  scr_str_hash_forget(s);
#ifdef SCR_RC_AUDIT
  scr_live_strings++;
#endif
  return s;
}

/* scr_copy_bytes that also reports whether the bytes are all ASCII. Short
 * spans test the words they already moved; longer ones scan after the bulk
 * copy, stopping at the first non-ASCII chunk. */
static bool scr_copy_bytes_ascii(char *dst, const char *src, size_t n) {
  const uint64_t high = UINT64_C(0x8080808080808080);
  if (n <= 16) {
    if (n >= 8) {
      uint64_t a, b;
      memcpy(&a, src, 8);
      memcpy(&b, src + n - 8, 8);
      memcpy(dst, &a, 8);
      memcpy(dst + n - 8, &b, 8);
      return ((a | b) & high) == 0;
    }
    if (n >= 4) {
      uint32_t a, b;
      memcpy(&a, src, 4);
      memcpy(&b, src + n - 4, 4);
      memcpy(dst, &a, 4);
      memcpy(dst + n - 4, &b, 4);
      return ((a | b) & UINT32_C(0x80808080)) == 0;
    }
    if (n == 0) return true;
    unsigned char c0 = (unsigned char)src[0], c1 = (unsigned char)src[n / 2],
                  c2 = (unsigned char)src[n - 1];
    dst[0] = (char)c0;
    dst[n / 2] = (char)c1;
    dst[n - 1] = (char)c2;
    return ((c0 | c1 | c2) & 0x80) == 0;
  }
  memcpy(dst, src, n);
  return scr_bytes_all_ascii(src, n);
}

ScrStr *scr_str_new(const char *bytes, size_t len) {
  ScrStr *s = scr_str_alloc(len, len);
  /* Proving ASCII while copying lets every later UTF-16 index, length and
   * slice skip the index cache. */
  bool ascii = scr_copy_bytes_ascii(s->data, bytes, len);
  s->data[len] = '\0';
  s->ascii = ascii;
  return s;
}

/* scr_str_new for bytes already known to be ASCII (slices of an ASCII
 * string): no scan. */
static ScrStr *scr_str_new_ascii(const char *bytes, size_t len) {
  ScrStr *s = scr_str_alloc(len, len);
  scr_copy_bytes(s->data, bytes, len);
  s->data[len] = '\0';
  s->ascii = 1;
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
    scr_str_hash_forget(s);
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
  if (newcap < s->len || newcap > SCR_STR_MAX_CAP) scr_oom();
  scr_short_forget(s);
  scr_str_hash_forget(s);
  scr_sidx_purge(s); /* realloc may move; the old address may be recycled */
  ScrStr *r = scr_mem_realloc(s, sizeof(ScrStr) + newcap + 1);
  if (!r) scr_oom();
  r->cap = newcap;
  return r;
}

void scr_str_release(ScrStr *s) {
  if (!s || s->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--s->rc == 0) {
    scr_short_forget(s);
    /* The address may be recycled by the next malloc. A proven-ASCII string
     * owns no index entry (scr_sidx_finish). */
    if (!s->ascii) scr_sidx_purge(s);
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
    scr_mem_free(s);
  }
}

/* a + b where a ends with a lone high surrogate and b starts with a lone
 * low one: the two units become one 4-byte character (scr_runtime.h). */
static __attribute__((noinline, cold)) ScrStr *scr_str_concat_joined(ScrStr *a, ScrStr *b) {
  size_t newlen = a->len + b->len;
  ScrStr *s = scr_str_alloc(newlen, newlen);
  memcpy(s->data, a->data, a->len);
  memcpy(s->data + a->len, b->data, b->len + 1);
  scr_str_fuse_from(s, a->len - 3);
  return s;
}

ScrStr *scr_str_concat(ScrStr *a, ScrStr *b) {
  if (a->len == 0) return scr_str_retain(b);
  if (b->len == 0) return scr_str_retain(a);
  if (a->len > SIZE_MAX - b->len - sizeof(ScrStr) - 1) scr_oom();
  /* Only two strings that are not proven ASCII can complete a pair. */
  if (__builtin_expect(scr_wtf8_any(), 0) && !a->ascii && !b->ascii &&
      scr_wtf8_joins(a->data, a->len, b->data, b->len))
    return scr_str_concat_joined(a, b);
  size_t newlen = a->len + b->len;
  /* In-place append: a is uniquely owned by the caller's borrow (rc == 1 —
   * never an interned literal, those are SIZE_MAX) and has room. Fires on
   * concat chains (`a + b + c`, template literals), where each intermediate
   * result reaches the next concat as a sole-reference temp. Any string
   * with rc > 1 might be aliased and is copied, never mutated. */
  bool ascii = a->ascii && b->ascii;
  if (a->rc == 1 && a != b && a->cap >= newlen) {
    size_t oldlen = a->len;
    scr_short_forget(a);
    scr_str_hash_forget(a);
    scr_copy_bytes(a->data + a->len, b->data, b->len);
    a->len = newlen;
    a->data[newlen] = '\0';
    a->ascii = ascii;
    /* A cached UTF-16 length for a is stale now; checkpoints and the exact
     * old prefix remain valid. Its old terminal point is no longer an END
     * fact (u16len is invalidated below), but remains an excellent ordinary
     * checkpoint for accesses around the append boundary. The next mapper
     * lazily continues from oldlen rather than scanning the unchanged prefix
     * again. An ASCII string that stays ASCII needs none of this: every
     * mapper answers it by identity before consulting an entry, and the
     * append that first adds non-ASCII bytes invalidates against its own
     * old length, which bounds every older fact as well. */
    if (!ascii) scr_sidx_concat_append(a, oldlen);
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
    size_t grown = (size_t)a->cap + (a->cap >> 1) + 16;
    if (grown > newcap) newcap = grown;
  } else if (newlen >= 512 && newlen <= (SIZE_MAX - sizeof(ScrStr) - 1) / 2) {
    newcap = newlen + (newlen >> 1);
  }
  if (newcap > SCR_STR_MAX_CAP && newlen <= SCR_STR_MAX_CAP) newcap = SCR_STR_MAX_CAP;
  ScrStr *s = scr_str_take_spare(newlen);
  if (!s) s = scr_str_alloc(newlen, newcap);
  scr_copy_bytes(s->data, a->data, a->len);
  scr_copy_bytes(s->data + a->len, b->data, b->len);
  s->data[newlen] = '\0';
  s->ascii = ascii;
  return s;
}

/* Whether some part of a concatenation starts with a lone low surrogate,
 * the only way a seam can complete a pair. A NULL part is a formatted
 * number, which is ASCII. */
static bool scr_str_parts_lead_low(ScrStr *const *parts, size_t count) {
  bool lead_low = false;
  for (size_t i = 0; i < count; i++) lead_low |= parts[i] && scr_wtf8_low_at(parts[i]->data);
  return lead_low;
}

/* The first seam of a concatenation result at which a part completes a
 * surrogate pair (scr_runtime.h), or 0 for none. The parts start at byte
 * `at` of out; a NULL part is nums[i] formatted. */
static size_t scr_str_first_seam(const ScrStr *out, size_t at, ScrStr *const *parts,
                                 const double *nums, size_t count) {
  for (size_t i = 0; i < count; i++) {
    const ScrStr *part = parts[i];
    if (!part) {
      char text[32];
      at += scr_f64_to_str(nums[i], text);
      continue;
    }
    if (part->len && scr_wtf8_joins(out->data, at, part->data, part->len)) return at;
    at += part->len;
  }
  return 0;
}

/* String and number operands of one concatenation, numbers formatted with
 * JavaScript's Number::toString straight into the result instead of through
 * temporary strings. parts[i] == NULL selects nums[i]. A head, when given,
 * follows scr_str_concat's left-operand rule: appended in place when the
 * caller's borrow is its only reference, it has room, and it is not also
 * one of the parts; otherwise copied, with geometric slack when unique. */
#define SCR_STR_MIXED_MAX 16
static __attribute__((noinline)) ScrStr *
scr_str_concat_mixed_bytes(ScrStr *head, ScrStr *const *parts, const double *nums, size_t count) {
  if (count > SCR_STR_MIXED_MAX) scr_trap("scriptc: internal error: too many concatenation parts\n");
  char text[SCR_STR_MIXED_MAX][32];
  size_t lens[SCR_STR_MIXED_MAX];
  const size_t limit = SCR_STR_MAX_CAP;
  size_t extra = 0;
  bool aliased = false;
  bool ascii = !head || head->ascii; /* formatted numbers are ASCII */
  for (size_t i = 0; i < count; i++) {
    if (parts[i]) {
      lens[i] = parts[i]->len;
      aliased |= parts[i] == head;
      ascii &= parts[i]->ascii;
    } else {
      lens[i] = scr_f64_to_str(nums[i], text[i]);
    }
    if (lens[i] > limit - extra) scr_oom();
    extra += lens[i];
  }
  size_t base = head ? head->len : 0;
  if (extra > limit - base) scr_oom();
  size_t newlen = base + extra;
  if (head && extra == 0) return scr_str_retain(head);
  ScrStr *out;
  size_t at;
  if (head && head->rc == 1 && !aliased && head->cap >= newlen) {
    /* See scr_str_concat's in-place append. */
    scr_short_forget(head);
    scr_str_hash_forget(head);
    out = head;
    at = base;
  } else {
    size_t newcap = newlen;
    if (head && head->rc == 1) {
      size_t grown = (size_t)head->cap + (head->cap >> 1) + 16;
      if (grown > newcap) newcap = grown;
    } else if (newlen >= 512 && newlen <= (SIZE_MAX - sizeof(ScrStr) - 1) / 2) {
      newcap = newlen + (newlen >> 1);
    }
    if (newcap > SCR_STR_MAX_CAP) newcap = SCR_STR_MAX_CAP;
    out = scr_str_take_spare(newlen);
    if (!out) out = scr_str_alloc(newlen, newcap);
    if (base) scr_copy_bytes(out->data, head->data, base);
    at = base;
  }
  for (size_t i = 0; i < count; i++) {
    scr_copy_bytes(out->data + at, parts[i] ? parts[i]->data : text[i], lens[i]);
    at += lens[i];
  }
  out->len = newlen;
  out->data[newlen] = '\0';
  out->ascii = ascii;
  if (out == head) {
    if (!ascii) scr_sidx_concat_append(head, base); /* see scr_str_concat */
    head->rc = 2; /* +1 for the returned reference, beside the caller's borrow */
  }
  return out;
}

/* A concatenation result that is not proven ASCII may have completed
 * surrogate pairs at its seams (scr_runtime.h). Its parts end the result;
 * the in-place head case drops its cached facts with the fuse. */
static __attribute__((noinline)) void scr_str_concat_rejoin(ScrStr *out, ScrStr *const *parts,
                                                            const double *nums, size_t count) {
  if (!scr_str_parts_lead_low(parts, count)) return;
  size_t extra = 0;
  for (size_t i = 0; i < count; i++) {
    char text[32];
    extra += parts[i] ? parts[i]->len : scr_f64_to_str(nums[i], text);
  }
  size_t seam = scr_str_first_seam(out, out->len - extra, parts, nums, count);
  if (seam) scr_str_fuse_from(out, seam - 3);
}

static __attribute__((noinline)) ScrStr *scr_str_concat_mixed_lone(ScrStr *head,
                                                                   ScrStr *const *parts,
                                                                   const double *nums,
                                                                   size_t count) {
  ScrStr *out = scr_str_concat_mixed_bytes(head, parts, nums, count);
  if (!out->ascii) scr_str_concat_rejoin(out, parts, nums, count);
  return out;
}

/* Until a lone surrogate may exist, this is a tail call of the byte
 * concatenation itself. */
/* UTF-16 units of a short span: bytes, less continuation bytes, plus one
 * for each 4-byte lead. Lane sums use a multiply rather than popcount,
 * which baseline x86-64 lacks. */
static inline size_t scr_utf16_units_short(const char *data, size_t len) {
  const uint64_t high = UINT64_C(0x8080808080808080), ones = UINT64_C(0x0101010101010101);
  size_t units = len, i = 0;
  for (; len - i >= 8; i += 8) {
    uint64_t w;
    memcpy(&w, data + i, 8);
    uint64_t cont = (w & ~(w << 1) & high) >> 7;
    uint64_t lead4 = (w & (w << 1) & (w << 2) & (w << 3) & high) >> 7;
    units -= (size_t)((cont * ones) >> 56);
    units += (size_t)((lead4 * ones) >> 56);
  }
  for (; i < len; i++) {
    unsigned char c = (unsigned char)data[i];
    units -= (c & 0xC0) == 0x80;
    units += c >= 0xF0;
  }
  return units;
}

/* A fresh concatenation (no head, the template-literal shape): numbers
 * format straight into the result, which reserves scr_f64_to_str's whole
 * 32-byte buffer for each. */
#define SCR_F64_TEXT_MAX 32
static __attribute__((noinline)) ScrStr *scr_str_concat_fresh(ScrStr *const *parts,
                                                              const double *nums, size_t count) {
  size_t reserve = 0;
  bool ascii = true;
  for (size_t i = 0; i < count; i++) {
    size_t n = parts[i] ? parts[i]->len : SCR_F64_TEXT_MAX;
    if (n > SCR_STR_MAX_CAP - reserve) scr_oom();
    reserve += n;
    if (parts[i]) ascii &= parts[i]->ascii;
  }
  ScrStr *out = scr_str_take_spare(reserve);
  if (!out) out = scr_str_alloc(reserve, reserve);
  char *w = out->data;
  for (size_t i = 0; i < count; i++) {
    if (parts[i]) {
      scr_copy_bytes(w, parts[i]->data, parts[i]->len);
      w += parts[i]->len;
    } else {
      w += scr_f64_to_str(nums[i], w);
    }
  }
  size_t len = (size_t)(w - out->data);
  out->len = len;
  out->data[len] = '\0';
  out->ascii = ascii;
  return out;
}

ScrStr *scr_str_concat_mixed(ScrStr *head, ScrStr *const *parts, const double *nums, size_t count) {
  if (__builtin_expect(scr_wtf8_any(), 0)) return scr_str_concat_mixed_lone(head, parts, nums, count);
  if (!head && count <= SCR_STR_MIXED_MAX) return scr_str_concat_fresh(parts, nums, count);
  return scr_str_concat_mixed_bytes(head, parts, nums, count);
}

ScrStr *scr_str_concat_move(ScrStr *a, ScrStr *b) {
  ScrStr *r = scr_str_concat(a, b);
  scr_str_release(a);
  return r;
}

ScrStr *scr_str_concat_move_char_code(ScrStr *a, double code) {
  uint32_t cp = scr_to_uint32(code) & 0xFFFFu;
  if (cp < 0x80 && a->rc == 1 && a->cap > a->len) {
    /* scr_str_concat's in-place append of one ASCII byte: the string stays
     * ASCII if it was, and a non-ASCII string's index facts below the old
     * end stay valid (scr_sidx_concat_append). */
    size_t oldlen = a->len;
    scr_short_forget(a);
    scr_str_hash_forget(a);
    a->data[oldlen] = (char)cp;
    a->len = oldlen + 1;
    a->data[oldlen + 1] = '\0';
    if (!a->ascii) scr_sidx_concat_append(a, oldlen);
    return a;
  }
  ScrStr *c = scr_str_from_char_code_one(code);
  ScrStr *r = scr_str_concat(a, c);
  scr_str_release(a);
  scr_str_release(c);
  return r;
}

ScrStr *scr_str_concat_mixed_move(ScrStr *head, ScrStr *const *parts, const double *nums,
                                  size_t count) {
  /* A head selects the general body directly (see scr_str_concat_mixed). */
  ScrStr *r = head && !__builtin_expect(scr_wtf8_any(), 0)
                  ? scr_str_concat_mixed_bytes(head, parts, nums, count)
                  : scr_str_concat_mixed(head, parts, nums, count);
  scr_str_release(head);
  return r;
}

ScrStr *scr_str_concat_f64(ScrStr *a, double x) {
  /* A head that cannot grow in place (a literal or a shared string): the
   * result is exactly its bytes and the number's. Digits complete no
   * surrogate pair, so no seam needs joining. */
  if (a->rc != 1) {
    char text[SCR_F64_TEXT_MAX];
    size_t n = scr_f64_to_str(x, text);
    if (a->len > SCR_STR_MAX_CAP - n) scr_oom();
    size_t len = a->len + n;
    ScrStr *out = scr_str_alloc(len, len);
    scr_copy_bytes(out->data, a->data, a->len);
    scr_copy_bytes(out->data + a->len, text, n);
    out->data[len] = '\0';
    out->ascii = a->ascii;
    return out;
  }
  ScrStr *none = NULL;
  return scr_str_concat_mixed(a, &none, &x, 1);
}

ScrStr *scr_str_concat_parts(ScrStr *const *parts, size_t count) {
  const size_t limit = SIZE_MAX - sizeof(ScrStr) - 1;
  size_t len = 0;
  ScrStr *only = NULL;
  size_t nonempty = 0;
  for (size_t i = 0; i < count; i++) {
    const size_t n = parts[i]->len;
    if (n > limit - len) scr_oom();
    len += n;
    if (n != 0) {
      only = parts[i];
      nonempty++;
    }
  }
  if (nonempty == 1) return scr_str_retain(only);
  ScrStr *out = scr_str_alloc_raw(len, len);
  size_t offset = 0;
  bool ascii = true;
  for (size_t i = 0; i < count; i++) {
    const ScrStr *part = parts[i];
    scr_copy_bytes(out->data + offset, part->data, part->len);
    offset += part->len;
    ascii &= part->ascii;
  }
  out->data[len] = '\0';
  out->ascii = ascii;
  if (__builtin_expect(scr_wtf8_any(), 0) && !ascii && scr_str_parts_lead_low(parts, count)) {
    size_t seam = scr_str_first_seam(out, 0, parts, NULL, count);
    if (seam) scr_str_fuse_from(out, seam - 3);
  }
  return out;
}

bool scr_str_eq(ScrStr *a, ScrStr *b) {
  return a == b || (a->len == b->len && scr_key_equal(a->data, b->data, a->len));
}

int scr_str_cmp(ScrStr *a, ScrStr *b) {
  size_t min = a->len < b->len ? a->len : b->len;
  int c = memcmp(a->data, b->data, min);
  if (c != 0) return c;
  return a->len < b->len ? -1 : (a->len > b->len ? 1 : 0);
}

static inline uint32_t scr_utf8_decode(const char *p, size_t *adv);

/* UTF-16 unit order of two strings from a shared character boundary. */
static __attribute__((noinline)) int scr_str_cmp_u16_units(const ScrStr *a, const ScrStr *b,
                                                           size_t i) {
  size_t ia = i, ib = i;
  uint32_t pa = 0, pb = 0; /* a pending low surrogate */
  for (;;) {
    if (!pa && ia == a->len) return pb || ib < b->len ? -1 : 0;
    if (!pb && ib == b->len) return 1;
    uint32_t ua = pa, ub = pb;
    size_t adv;
    if (!ua) {
      uint32_t cp = scr_utf8_decode(a->data + ia, &adv);
      ia += adv;
      if (cp >= 0x10000) {
        ua = 0xD800 + ((cp - 0x10000) >> 10);
        pa = 0xDC00 + ((cp - 0x10000) & 0x3FF);
      } else {
        ua = cp;
      }
    } else {
      pa = 0;
    }
    if (!ub) {
      uint32_t cp = scr_utf8_decode(b->data + ib, &adv);
      ib += adv;
      if (cp >= 0x10000) {
        ub = 0xD800 + ((cp - 0x10000) >> 10);
        pb = 0xDC00 + ((cp - 0x10000) & 0x3FF);
      } else {
        ub = cp;
      }
    } else {
      pb = 0;
    }
    if (ua != ub) return ua < ub ? -1 : 1;
  }
}

/* UTF-16 ordering over canonical WTF-8. Equal bytes can be skipped even
 * inside a multibyte character: unequal continuation bytes preserve code
 * point order. Differing lead bytes for U+E000..U+FFFF versus a
 * supplementary character reverse byte order, because the latter starts
 * with a UTF-16 high surrogate below U+E000. A lone surrogate against a
 * supplementary character compares their units. */
int scr_str_cmp_u16(ScrStr *a, ScrStr *b) {
  if (a == b) return 0;
  size_t common = a->len < b->len ? a->len : b->len;
  size_t i = 0;
  while (common - i >= sizeof(uint64_t)) {
    uint64_t left, right;
    memcpy(&left, a->data + i, sizeof(left));
    memcpy(&right, b->data + i, sizeof(right));
    if (left != right) break;
    i += sizeof(left);
  }
  while (i < common && a->data[i] == b->data[i]) i++;
  if (i == common) return (a->len > b->len) - (a->len < b->len);
  unsigned char left = (unsigned char)a->data[i];
  unsigned char right = (unsigned char)b->data[i];
  if (left >= 0xf0 && right >= 0xee && right <= 0xef) return -1;
  if (right >= 0xf0 && left >= 0xee && left <= 0xef) return 1;
  if (__builtin_expect((left == 0xed && right >= 0xf0 && scr_wtf8_surrogate_at(a->data + i)) ||
                           (right == 0xed && left >= 0xf0 && scr_wtf8_surrogate_at(b->data + i)),
                       0))
    return scr_str_cmp_u16_units(a, b, i);
  return left < right ? -1 : 1;
}

/* ── interned strings ─────────────────────────────────────────────────
 * The empty string and every single-character ASCII string are immortal
 * statics (same layout the emitter uses for literals): charAt/slice churn
 * in tight loops returns these without allocating.
 */
typedef struct { size_t rc; size_t len; size_t cap; char data[2]; } ScrChar1;
#define SCR_A_WORD(c) (((uint64_t)(c) << 16) | ((uint64_t)(c) << 8) | (uint64_t)(c))
#define SCR_A(c) {SIZE_MAX, 1, SCR_STR_CAP_WORD(1, SCR_KEY_HASH32_SHORT(1, SCR_A_WORD(c)), 1), {(char)(c), 0}}
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
    scr_lit_empty = {SIZE_MAX, 0, SCR_STR_CAP_WORD(0, SCR_KEY_HASH32_SHORT(0, 0), 1), ""};

static ScrStr *scr_str_empty(void) { return (ScrStr *)&scr_lit_empty; }

/* Empty/ASCII characters are immortal; tiny spans share live heap strings. */
static ScrStr *scr_str_from_span(const char *bytes, size_t len) {
  if (len == 0) return scr_str_empty();
  if (len == 1 && (unsigned char)bytes[0] < 0x80) {
    return (ScrStr *)&scr_ascii1[(unsigned char)bytes[0]];
  }
  if (len >= 2 && len <= 4) {
    uint32_t word = scr_short_word(bytes, len);
    size_t h = scr_short_slot(word, len);
    ScrStr *cached = scr_short_tab[h];
    if (cached && cached->len == len && scr_short_word(cached->data, len) == word)
      return scr_str_retain(cached);
    ScrStr *s = scr_str_new(bytes, len);
    scr_short_tab[h] = s;
    return s;
  }
  return scr_str_new(bytes, len);
}

/* scr_str_from_span for a span of a proven-ASCII string: the result is
 * ASCII without another scan. */
static ScrStr *scr_str_from_span_ascii(const char *bytes, size_t len) {
  if (len <= 4) return scr_str_from_span(bytes, len);
  return scr_str_new_ascii(bytes, len);
}

/* A scalar fromCharCode needs neither the variadic argument array nor an
 * encoding buffer. Reuse the same empty/ASCII/tiny-span storage policy as
 * character indexing. A surrogate unit is a lone surrogate. */
ScrStr *scr_str_from_char_code_one(double code) {
  uint32_t cp = scr_to_uint32(code) & 0xFFFFu;
  if (cp < 0x80) return (ScrStr *)&scr_ascii1[cp];
  if (cp >= 0xD800 && cp <= 0xDFFF) scr_wtf8_note();
  char bytes[3];
  if (cp < 0x800) {
    bytes[0] = (char)(0xC0 | (cp >> 6));
    bytes[1] = (char)(0x80 | (cp & 0x3F));
    return scr_str_from_span(bytes, 2);
  }
  bytes[0] = (char)(0xE0 | (cp >> 12));
  bytes[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
  bytes[2] = (char)(0x80 | (cp & 0x3F));
  return scr_str_from_span(bytes, 3);
}

/* ── string methods: UTF-16 semantics over WTF-8 storage ──────────
 * All strings in the system are canonical WTF-8 (scr_runtime.h): valid
 * UTF-8 sequences plus 3-byte lone surrogates, so the decode helpers below
 * may assume valid sequences and never validate. A lone surrogate decodes
 * as its own code unit through the ordinary 3-byte arm.
 */

/* Byte length of the WTF-8 sequence starting at lead byte c. */
static inline size_t scr_utf8_seq_len(unsigned char c) {
  if (c < 0x80) return 1;
  if (c < 0xE0) return 2;
  if (c < 0xF0) return 3;
  return 4;
}

/* Decode the code point (or lone surrogate) at p (canonical WTF-8); *adv
 * gets the byte length of the sequence. */
static inline uint32_t scr_utf8_decode(const char *p, size_t *adv) {
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

/* ── WTF-8 lone surrogates (scr_runtime.h) ────────────────────────── */

/* Explicitly initialized for library localization (see scr_str_scan). */
bool scr_wtf8_lone = false;

void scr_wtf8_note(void) {
  if (!scr_wtf8_any()) __atomic_store_n(&scr_wtf8_lone, true, __ATOMIC_RELAXED);
}

const char *scr_wtf8_find_surrogate(const char *p, size_t n) {
  const char *end = p + n;
  while (n >= 3) {
    const char *hit = memchr(p, 0xED, n - 2);
    if (!hit) return NULL;
    if ((unsigned char)hit[1] >= 0xA0) return hit;
    p = hit + 3; /* ED lead of a U+D000..D7FF character */
    n = (size_t)(end - p);
  }
  return NULL;
}

size_t scr_wtf8_put(char *dst, uint32_t cp) {
  if (cp < 0x80) {
    dst[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800) {
    dst[0] = (char)(0xC0 | (cp >> 6));
    dst[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    if (cp >= 0xD800 && cp <= 0xDFFF) scr_wtf8_note();
    dst[0] = (char)(0xE0 | (cp >> 12));
    dst[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    dst[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  dst[0] = (char)(0xF0 | (cp >> 18));
  dst[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  dst[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  dst[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

/* The surrogate unit of the lone sequence at p. */
static uint32_t scr_wtf8_unit(const char *p) {
  return 0xD000u | (((uint32_t)(unsigned char)p[1] & 0x3F) << 6) |
         ((uint32_t)(unsigned char)p[2] & 0x3F);
}

size_t scr_wtf8_fuse(char *p, size_t n) {
  size_t r = 0, w = 0;
  for (;;) {
    const char *hit = scr_wtf8_find_surrogate(p + r, n - r);
    size_t at = hit ? (size_t)(hit - p) : n;
    if (w != r) memmove(p + w, p + r, at - r);
    w += at - r;
    r = at;
    if (!hit) return w;
    if (((unsigned char)p[r + 1] & 0xF0) == 0xA0 && n - r >= 6 &&
        scr_wtf8_surrogate_at(p + r + 3) && (unsigned char)p[r + 4] >= 0xB0) {
      uint32_t hi = scr_wtf8_unit(p + r), lo = scr_wtf8_unit(p + r + 3);
      w += scr_wtf8_put(p + w, 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00));
      r += 6;
    } else {
      memmove(p + w, p + r, 3);
      w += 3;
      r += 3;
    }
  }
}

void scr_str_fuse_from(ScrStr *s, size_t from) {
  scr_short_forget(s);
  scr_str_hash_forget(s);
  scr_sidx_purge(s);
  s->len = from + scr_wtf8_fuse(s->data + from, s->len - from);
  s->data[s->len] = '\0';
}

__attribute__((noinline, cold)) void scr_str_fuse_surrogates(ScrStr *s) {
  scr_short_forget(s);
  scr_str_hash_forget(s);
  scr_sidx_purge(s);
  s->len = scr_wtf8_fuse(s->data, s->len);
  s->data[s->len] = '\0';
}

void scr_wtf8_replace_surrogates(char *p, size_t n) {
  const char *end = p + n;
  for (char *hit; (hit = (char *)scr_wtf8_find_surrogate(p, (size_t)(end - p))); p = hit + 3)
    memcpy(hit, "\xEF\xBF\xBD", 3);
}

const char *scr_str_utf8_copy(const ScrStr *s, char **owned) {
  const char *hit = scr_wtf8_find_surrogate(s->data, s->len);
  if (!hit) return s->data;
  char *copy = malloc(s->len + 1);
  if (!copy) scr_oom();
  memcpy(copy, s->data, s->len + 1);
  size_t at = (size_t)(hit - s->data);
  scr_wtf8_replace_surrogates(copy + at, s->len - at);
  *owned = copy;
  return copy;
}

/* A one-unit string holding the lone surrogate `unit`. */
static ScrStr *scr_str_from_unit(uint32_t unit) {
  char bytes[3];
  scr_wtf8_put(bytes, unit);
  return scr_str_from_span(bytes, 3);
}

/* The high and low surrogates of the astral code point cp. */
static inline uint32_t scr_cp_high(uint32_t cp) { return 0xD800 + ((cp - 0x10000) >> 10); }
static inline uint32_t scr_cp_low(uint32_t cp) { return 0xDC00 + ((cp - 0x10000) & 0x3FF); }

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
    /* A pre-existing mixed prefix can only belong to a receiver that grew
     * across the admission threshold while it was in the cursor tier. Its
     * exact terminal anchor is useful immediately, but it does not promise
     * a stride-bounded route through that old prefix. On completion, rebuild
     * once from zero rather than mistaking this short-history anchor for a
     * fully formed sparse index. */
    e->points_complete = e->indexed_cb == e->indexed_cu;
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
  if (s->len < SCR_SIDX_MIN_BYTES || e->points_complete ||
      e->no_more_points)
    return;
  free(e->points);
  e->points = NULL;
  e->npoints = 0;
  e->cap = 0;
  size_t cu = 0, cb = 0;
  if (!scr_sidx_add_point(e, cu, cb, true)) return;
  while (cb < s->len) {
    size_t end = scr_sidx_next_boundary(s, cb);
    cu += scr_utf16_units_span(s->data + cb, end - cb, NULL);
    cb = end;
    if (!scr_sidx_add_point(e, cu, cb, true)) return;
  }
  e->points_complete = true;
}

/* Completing a scan that proves a heap string ASCII records the fact in its
 * header and drops the entry: a proven-ASCII string never owns one (every
 * mapper answers it by identity first, and a release of it skips the
 * purge). Callers re-check the header bit before touching the entry again.
 * Immortal strings cannot record the bit and keep the entry. */
static void scr_sidx_finish(const ScrStr *s, ScrSidx *e) {
  if (e->indexed_cb != s->len) return;
  e->u16len = e->indexed_cu;
  if (e->u16len == s->len) { /* proven all ASCII: identity needs no index */
    if (s->rc != SIZE_MAX) {
      ((ScrStr *)s)->ascii = 1;
      bool sparse = (uintptr_t)e - (uintptr_t)scr_sidx_sparse_tab < sizeof scr_sidx_sparse_tab;
      scr_sidx_clear(e, sparse ? &scr_sidx_sparse_live : NULL);
      return;
    }
    free(e->points);
    e->points = NULL;
    e->npoints = 0;
    e->cap = 0;
    e->points_complete = false;
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
  if (s->ascii) return s->len;
  if (e->u16len != SCR_U16_UNKNOWN) return e->u16len;
  while (e->indexed_cb < s->len) scr_sidx_extend_one(s, e);
  scr_sidx_finish(s, e);
  return s->ascii ? s->len : e->u16len;
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
  /* A nearby cursor already bounds the walk. Searching the complete index
   * first would make each sequential read depend on the receiver's size. */
  if (e->cb <= s->len && scr_sidx_abs_diff(e->cu, u16) <= 16)
    return (ScrSidxPoint){e->cu, e->cb};
  ScrSidxPoint best = {0, 0};
  size_t best_dist = u16;
  if (e->npoints != 0) {
    SCR_SIDX_SEARCH();
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
  if (e->cb <= s->len && scr_sidx_abs_diff(e->cb, byte_off) <= 16)
    return (ScrSidxPoint){e->cu, e->cb};
  ScrSidxPoint best = {0, 0};
  size_t best_dist = byte_off;
  if (e->npoints != 0) {
    SCR_SIDX_SEARCH();
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

/* Cache only a bounded ASCII run at a resolved boundary. Local scans then
 * use arithmetic even inside a mixed string. The bytes are immutable except
 * for append, which preserves this prefix; eviction/reallocation clears the
 * whole entry. No scan reads outside the receiver or allocates metadata. */
static void scr_sidx_ascii_run(const ScrStr *s, ScrSidx *e) {
  size_t start = e->cb, end = start;
  /* Center the window on the access so reverse scans reuse it too. A
   * forward-only window would rescan its full width on every backward read. */
  size_t lower = start < 128 ? 0 : start - 128;
  while (start - lower >= 8) {
    uint64_t word;
    memcpy(&word, s->data + start - 8, 8);
    if (word & UINT64_C(0x8080808080808080)) break;
    start -= 8;
  }
  while (start > lower && (unsigned char)s->data[start - 1] < 0x80) start--;
  size_t remaining = s->len - end;
  size_t limit = end + (remaining < 128 ? remaining : 128);
  while (limit - end >= 8) {
    uint64_t word;
    memcpy(&word, s->data + end, 8);
    if (word & UINT64_C(0x8080808080808080)) break;
    end += 8;
  }
  while (end < limit && (unsigned char)s->data[end] < 0x80) end++;
  e->ascii_cu = e->cu - (e->cb - start);
  e->ascii_cb = start;
  e->ascii_end = end;
}

/* How far past its end a forward access may grow the cached ASCII run, and
 * how far beyond the access the growth looks ahead. */
#define SCR_SIDX_ASCII_REACH ((size_t)4096)
#define SCR_SIDX_ASCII_AHEAD ((size_t)256)

/* Grow the cached ASCII run forward until it covers byte `want` (plus a
 * lookahead) or meets a non-ASCII byte. The run stays one contiguous ASCII
 * span starting at the unit/byte pair (ascii_cu, ascii_cb), so a scan that
 * reads a mostly ASCII text front to back (a scanner taking substrings at
 * increasing offsets) tests each byte once instead of walking from the
 * cursor and re-centring the run every 128 bytes. Only accesses up to
 * SCR_SIDX_ASCII_REACH past the run try: the walk below bounds the rest. */
static bool scr_sidx_ascii_grow(const ScrStr *s, ScrSidx *e, size_t want) {
  size_t end = e->ascii_end;
  if (want < end || want >= s->len || want - end > SCR_SIDX_ASCII_REACH) return false;
  size_t limit = s->len - want > SCR_SIDX_ASCII_AHEAD ? want + SCR_SIDX_ASCII_AHEAD : s->len;
  while (limit - end >= 8) {
    uint64_t word;
    memcpy(&word, s->data + end, 8);
    if (word & UINT64_C(0x8080808080808080)) break;
    end += 8;
  }
  while (end < limit && (unsigned char)s->data[end] < 0x80) end++;
  e->ascii_end = end;
  return want < end;
}

static size_t scr_u16_to_byte_walk(const ScrStr *s, ScrSidx *e, size_t u16,
                                   bool *mid);

/* Convert a UTF-16 index to a byte offset from the closest sparse anchor or
 * hot cursor. If u16 addresses the second (low-surrogate) unit of
 * an astral char, *mid is set and the returned offset is the START of that
 * 4-byte sequence. u16 at or past the end returns s->len with *mid false.
 * Same contract as a from-scratch scan. The identity and ASCII-run cases
 * inline into callers; everything else is out of line. */
static inline size_t scr_u16_to_byte_c(const ScrStr *s, ScrSidx *e, size_t u16,
                                        bool *mid) {
  if (s->ascii || e->u16len == s->len) { /* all ASCII: identity mapping */
    *mid = false;
    return u16 < s->len ? u16 : s->len;
  }
  if (u16 >= e->ascii_cu && u16 - e->ascii_cu < e->ascii_end - e->ascii_cb) {
    e->cb = e->ascii_cb + (u16 - e->ascii_cu);
    e->cu = u16;
    *mid = false;
    return e->cb;
  }
  return scr_u16_to_byte_walk(s, e, u16, mid);
}

static __attribute__((noinline)) size_t scr_u16_to_byte_walk(const ScrStr *s, ScrSidx *e,
                                                             size_t u16, bool *mid) {
  /* A short step forward from the hot cursor (a sequential scan of
   * non-ASCII text) walks from the cursor itself. */
  if (u16 >= e->cu && u16 - e->cu <= 8) {
    size_t cu = e->cu, cb = e->cb;
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
    if (cu == u16 || m) {
      e->cu = cu;
      e->cb = cb;
      if (cb < s->len && (unsigned char)s->data[cb] < 0x80) scr_sidx_ascii_run(s, e);
      *mid = m;
      return cb;
    }
  }
  if (u16 >= e->ascii_cu && scr_sidx_ascii_grow(s, e, e->ascii_cb + (u16 - e->ascii_cu))) {
    e->cb = e->ascii_cb + (u16 - e->ascii_cu);
    e->cu = u16;
    *mid = false;
    return e->cb;
  }
  scr_sidx_extend_to_u16(s, e, u16);
  /* Extending a far-end lookup can just have proved identity. Do not
   * materialize an index that the identity fast path will never consult. */
  if (s->ascii || e->u16len == s->len) {
    *mid = false;
    return u16 < s->len ? u16 : s->len;
  }
  scr_sidx_materialize_identity_prefix(s, e);
  ScrSidxPoint near = scr_sidx_near_u16(s, e, u16);
  size_t cu = near.cu, cb = near.cb;
  while (cu > u16) {
    /* Eight bytes starting inside a sequence can reach back at most three
     * more bytes to its lead. Such a span contains at most nine UTF-16
     * units (seven ASCII bytes plus an astral pair), so it cannot overshoot
     * a target at least nine units away. */
    if (cu - u16 >= 9 && cb >= 8) {
      size_t start = cb - 8;
      while (start > 0 && ((unsigned char)s->data[start] & 0xC0) == 0x80)
        start--;
      cu -= scr_utf16_units_span(s->data + start, cb - start, NULL);
      cb = start;
    } else {
      scr_sidx_back(s, &cu, &cb);
    }
  }
  bool m = false;
  while (cu < u16 && cb < s->len) {
    if (u16 - cu >= 9 && s->len - cb >= 8) {
      size_t end = cb + 8;
      while (end < s->len && ((unsigned char)s->data[end] & 0xC0) == 0x80)
        end++;
      cu += scr_utf16_units_span(s->data + cb, end - cb, NULL);
      cb = end;
      continue;
    }
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
  if (cb < s->len && (unsigned char)s->data[cb] < 0x80)
    scr_sidx_ascii_run(s, e);
  *mid = m;
  return cb;
}

static size_t scr_byte_to_u16_walk(const ScrStr *s, ScrSidx *e, size_t byte_off);

/* Convert a byte offset (must be a char boundary) to a UTF-16 index from
 * the closest sparse anchor or hot cursor. As above, the identity and
 * ASCII-run cases inline into callers. */
static inline size_t scr_byte_to_u16_c(const ScrStr *s, ScrSidx *e,
                                        size_t byte_off) {
  if (s->ascii || e->u16len == s->len) return byte_off; /* all ASCII */
  if (byte_off >= e->ascii_cb && byte_off < e->ascii_end) {
    e->cu = e->ascii_cu + (byte_off - e->ascii_cb);
    e->cb = byte_off;
    return e->cu;
  }
  return scr_byte_to_u16_walk(s, e, byte_off);
}

static __attribute__((noinline)) size_t scr_byte_to_u16_walk(const ScrStr *s, ScrSidx *e,
                                                             size_t byte_off) {
  if (byte_off >= e->ascii_cb && scr_sidx_ascii_grow(s, e, byte_off)) {
    e->cu = e->ascii_cu + (byte_off - e->ascii_cb);
    e->cb = byte_off;
    return e->cu;
  }
  /* A byte search result may be far beyond the existing prefix. Build the
   * same sparse intervals first, then choose the closest boundary anchor. */
  if (byte_off > e->indexed_cb) {
    while (e->indexed_cb < byte_off) scr_sidx_extend_one(s, e);
    scr_sidx_finish(s, e);
  }
  /* As above, a completed all-ASCII scan is its own index. In particular,
   * do not rebuild points that scr_sidx_finish() deliberately discarded. */
  if (s->ascii || e->u16len == s->len) return byte_off;
  scr_sidx_materialize_identity_prefix(s, e);
  ScrSidxPoint near = scr_sidx_near_byte(s, e, byte_off);
  size_t cu = near.cu, cb = near.cb;
  /* Unlike unit-to-byte conversion, both endpoints are already exact byte
   * boundaries. Count the whole span with the shared word-wise classifier. */
  if (cb > byte_off)
    cu -= scr_utf16_units_span(s->data + byte_off, cb - byte_off, NULL);
  else
    cu += scr_utf16_units_span(s->data + cb, byte_off - cb, NULL);
  cb = byte_off;
  e->cu = cu;
  e->cb = cb;
  if (cb < s->len && (unsigned char)s->data[cb] < 0x80)
    scr_sidx_ascii_run(s, e);
  return cu;
}

/* ECMA-262 ToIntegerOrInfinity for a double already known to be a Number:
 * NaN → +0, otherwise truncate toward zero, ±Infinity preserved. */
static double scr_to_integer_or_infinity(double x) {
  if (isnan(x)) return 0.0;
  return trunc(x);
}

/* Byte substring search (needle and hay are both canonical WTF-8,
 * so any byte-level match starts on a char boundary — UTF-8 is
 * self-synchronizing). Empty needle matches at hay. */
static const char *scr_byte_find(const char *hay, size_t hay_len,
                                  const char *nee, size_t nee_len) {
  if (nee_len == 0) return hay;
  if (nee_len > hay_len) return NULL;
  if (nee_len == 1) return memchr(hay, (unsigned char)nee[0], hay_len);
  const unsigned char first = (unsigned char)nee[0];
  const unsigned char second = (unsigned char)nee[1];
  /* The last possible match start. */
  const char *last = hay + (hay_len - nee_len);
  const char *p = hay;
  if (hay_len <= 256) {
    /* Short haystacks (paths, names, keys) often repeat the first needle
     * byte ('/' in "//" or "/../"), so one memchr per occurrence costs more
     * than the scan. Test eight candidate starts per step: a start matches
     * the first two needle bytes where both XORed words have a zero byte.
     * The zero-byte test has no false negatives; its rare false positives
     * (a 0x01 byte above a zero byte) are filtered by the byte checks. Each
     * step reads p[0..8], within the haystack because p + 8 <= last. */
    const uint64_t ones = UINT64_C(0x0101010101010101);
    const uint64_t highs = UINT64_C(0x8080808080808080);
    const uint64_t want0 = ones * first, want1 = ones * second;
    while ((size_t)(last - p) >= 8) {
      uint64_t w0, w1;
      memcpy(&w0, p, 8);
      memcpy(&w1, p + 1, 8);
      uint64_t z = (w0 ^ want0) | (w1 ^ want1);
      if ((z - ones) & ~z & highs) {
        for (int k = 0; k < 8; k++) {
          const char *c = p + k;
          if ((unsigned char)c[0] == first && (unsigned char)c[1] == second &&
              memcmp(c + 2, nee + 2, nee_len - 2) == 0)
            return c;
        }
      }
      p += 8;
    }
    for (; p <= last; p++) {
      if ((unsigned char)p[0] == first && (unsigned char)p[1] == second &&
          memcmp(p + 2, nee + 2, nee_len - 2) == 0)
        return p;
    }
    return NULL;
  }
  while (p <= last) {
    const char *found = memchr(p, first, (size_t)(last - p) + 1);
    if (!found) return NULL;
    if ((unsigned char)found[1] == second &&
        memcmp(found + 2, nee + 2, nee_len - 2) == 0)
      return found;
    p = found + 1;
  }
  return NULL;
}

/* ── searches for a needle that can match half of a surrogate pair ─────
 * Canonical storage makes byte matches exact for every needle except one
 * that starts with a lone low surrogate or ends with a lone high one: JS
 * finds those inside a haystack's surrogate pairs. Such needles search
 * UTF-16 copies of both strings; every other needle never gets here. */
static inline bool scr_needle_halves_pairs(const ScrStr *n) {
  return __builtin_expect(
      scr_wtf8_any() && !n->ascii && n->len >= 3 &&
          (((unsigned char)n->data[0] == 0xED && (unsigned char)n->data[1] >= 0xB0) ||
           ((unsigned char)n->data[n->len - 3] == 0xED &&
            ((unsigned char)n->data[n->len - 2] & 0xF0) == 0xA0)),
      0);
}

/* The UTF-16 code units of s (malloc'd); *n gets their count. */
static uint16_t *scr_str_units(const ScrStr *s, size_t *n) {
  uint16_t *u = malloc((s->len + 1) * sizeof *u); /* units <= bytes */
  if (!u) scr_oom();
  size_t k = 0;
  for (size_t i = 0; i < s->len;) {
    size_t adv;
    uint32_t cp = scr_utf8_decode(s->data + i, &adv);
    i += adv;
    if (cp >= 0x10000) {
      u[k++] = (uint16_t)scr_cp_high(cp);
      u[k++] = (uint16_t)scr_cp_low(cp);
    } else {
      u[k++] = (uint16_t)cp;
    }
  }
  *n = k;
  return u;
}

/* Indexed reads of one non-ASCII receiver (charCodeAt/charAt scans) map
 * UTF-16 units to bytes through the cursor and checkpoints. Once its
 * reads would have paid for converting it (one read per 16 bytes), a
 * receiver up to SCR_SIDX_UNITS_MAX units keeps its code units in its
 * entry and reads become loads. The array is freed with the entry, and an
 * append drops it (scr_sidx_concat_append). */
#define SCR_SIDX_UNITS_MAX ((size_t)1 << 20)
static bool scr_sidx_units(const ScrStr *s, ScrSidx *e) {
  if (!e->units) {
    if (++e->reads < 32 || e->reads * 16 < s->len || s->len > SCR_SIDX_UNITS_MAX) return false;
    e->units = scr_str_units(s, &e->nunits);
  }
  /* Publish the scan's receiver for emitted reads (scr_runtime.h). */
  if (scr_str_scan.s != s) {
    scr_str_scan.s = s;
    scr_str_scan.units = e->units;
    scr_str_scan.n = e->nunits;
  }
  return true;
}

typedef enum { SCR_UNIT_FIRST, SCR_UNIT_LAST, SCR_UNIT_AT } ScrUnitSearch;

/* The UTF-16 index of needle in s: the first match at or after `from`,
 * the last one starting at or before it, or a match exactly at it; -1
 * when there is none. `from` is already clamped to s's length. */
static __attribute__((noinline)) double scr_str_unit_search(const ScrStr *s, const ScrStr *needle,
                                                            size_t from, ScrUnitSearch mode) {
  size_t hn, nn;
  uint16_t *h = scr_str_units(s, &hn), *n = scr_str_units(needle, &nn);
  double found = -1.0;
  if (nn <= hn && (mode == SCR_UNIT_LAST || from <= hn - nn)) {
    size_t last = hn - nn;
    if (from > last) from = last;
    if (mode == SCR_UNIT_AT) {
      if (memcmp(h + from, n, nn * sizeof *n) == 0) found = (double)from;
    } else if (mode == SCR_UNIT_LAST) {
      for (size_t at = from + 1; at-- > 0;) {
        if (memcmp(h + at, n, nn * sizeof *n) == 0) {
          found = (double)at;
          break;
        }
      }
    } else {
      for (size_t at = from; at <= last; at++) {
        if (memcmp(h + at, n, nn * sizeof *n) == 0) {
          found = (double)at;
          break;
        }
      }
    }
  }
  free(h);
  free(n);
  return found;
}

/* Search backwards from a clamped UTF-16 position. A low-surrogate position
 * maps to its scalar's first byte, so that scalar remains searchable. */
double scr_str_last_index_of_from(ScrStr *s, ScrStr *needle, double position) {
  ScrSidx *e = scr_sidx_for(s);
  size_t len16 = scr_sidx_len(s, e);
  size_t start16 = isnan(position) || position >= (double)len16 ? len16
                   : position <= 0 ? 0 : (size_t)trunc(position);
  if (needle->len == 0) return (double)start16;
  if (needle->len > s->len) return -1.0;
  if (scr_needle_halves_pairs(needle)) return scr_str_unit_search(s, needle, start16, SCR_UNIT_LAST);
  bool mid;
  size_t start_byte = scr_u16_to_byte_c(s, e, start16, &mid);
  size_t max_start = s->len - needle->len;
  if (start_byte < max_start) max_start = start_byte;
  for (size_t i = max_start + 1; i-- > 0;) {
    if (memcmp(s->data + i, needle->data, needle->len) == 0) {
      return (double)scr_byte_to_u16_c(s, e, i);
    }
  }
  return -1.0;
}

double scr_str_last_index_of(ScrStr *s, ScrStr *needle) {
  return scr_str_last_index_of_from(s, needle, INFINITY);
}

double scr_str_utf16_len(ScrStr *s) {
  if (s->ascii) return (double)s->len;
  /* A short receiver is counted directly: claiming an index entry for it
   * would evict the cursor of a long receiver being scanned meanwhile. */
  if (s->len <= 64) return (double)(int64_t)scr_utf16_units_short(s->data, s->len);
  ScrSidx *last = scr_sidx_last; /* a scan's receiver, length known */
  if (last && last->s == s && last->u16len != SCR_U16_UNKNOWN)
    return (double)(int64_t)last->u16len; /* lengths fit int64_t */
  return (double)scr_sidx_len(s, scr_sidx(s));
}

double scr_str_char_code_at(ScrStr *s, double i) {
  /* A sequential scan of a non-ASCII receiver stays inside the bounded
   * ASCII span cached at its last resolved position. Its unit offset is an
   * integer, so trunc(i) - ascii_cu == trunc(i - ascii_cu) for i at or past
   * it; NaN and anything before the span fail the comparison. */
  ScrSidx *last = scr_sidx_last;
  if (last && last->s == s && !s->ascii && i >= 0 && i < 9007199254740992.0) {
    /* ToIntegerOrInfinity of a nonnegative safe index is truncation, done
     * once in the integer domain. */
    size_t k = (size_t)(int64_t)i;
    if (scr_sidx_units(s, last)) return k < last->nunits ? (double)last->units[k] : NAN;
    if (k >= last->ascii_cu && k - last->ascii_cu < last->ascii_end - last->ascii_cb) {
      last->cu = k;
      last->cb = last->ascii_cb + (k - last->ascii_cu);
      return (double)(unsigned char)s->data[last->cb];
    }
    /* The unit right after the hot cursor's (a sequential scan through
     * non-ASCII text): the low half of an astral character at the cursor,
     * or the unit that starts the next character. */
    if (k == last->cu + 1 && last->cb < s->len) {
      size_t adv, seq = scr_utf8_seq_len((unsigned char)s->data[last->cb]);
      if (seq == 4) return (double)scr_cp_low(scr_utf8_decode(s->data + last->cb, &adv));
      size_t cb = last->cb + seq;
      if (cb < s->len) {
        last->cu++;
        last->cb = cb;
        unsigned char c = (unsigned char)s->data[cb];
        if (c < 0x80) return (double)c;
        uint32_t cp = scr_utf8_decode(s->data + cb, &adv);
        return (double)(cp < 0x10000 ? cp : scr_cp_high(cp));
      }
    }
  }
  double idx = scr_to_integer_or_infinity(i);
  if (!(idx >= 0)) return NAN; /* negative or -Infinity */
  /* UTF-16 length <= byte length always, so this also fences the cast. */
  if (idx >= (double)s->len) return NAN;
  if (s->ascii) return (double)(unsigned char)s->data[(size_t)idx];
  ScrSidx *e = scr_sidx(s);
  if (s->ascii || e->u16len == s->len) return (double)(unsigned char)s->data[(size_t)idx];
  if (scr_sidx_units(s, e)) return idx < (double)e->nunits ? (double)e->units[(size_t)idx] : NAN;
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
  if (needle->len > s->len) return -1.0;
  ScrSidx *e = scr_sidx_for(s);
  /* Per spec, the empty needle is found at the clamped fromIndex itself —
   * even when that index is between the halves of an astral pair. */
  if (needle->len == 0) {
    size_t len16 = scr_sidx_len(s, e);
    return pos <= 0 ? 0 : pos >= (double)len16 ? (double)len16 : pos;
  }
  /* Byte length bounds UTF-16 length and fences the cast. Let the mapper
   * extend only as far as needed instead of indexing an unsearched suffix. */
  if (pos >= (double)s->len) return -1.0;
  size_t start16 = pos <= 0 ? 0 : (size_t)pos;
  if (scr_needle_halves_pairs(needle)) {
    size_t len16 = scr_sidx_len(s, e);
    return scr_str_unit_search(s, needle, start16 > len16 ? len16 : start16, SCR_UNIT_FIRST);
  }
  bool mid;
  size_t start_b = scr_u16_to_byte_c(s, e, start16, &mid);
  /* Only the needles handled above can begin on a low-surrogate half, so
   * resume at the next char boundary. */
  if (mid) start_b += 4;
  const char *found =
      scr_byte_find(s->data + start_b, s->len - start_b, needle->data,
                     needle->len);
  if (!found) return -1.0;
  return (double)scr_byte_to_u16_c(s, e, (size_t)(found - s->data));
}

static ScrStr *scr_str_slice_units(ScrStr *s, ScrSidx *e,
                                    size_t from, size_t to);

/* Normalize once, then share slice's extraction without another cache
 * lookup, length query or floating-point boundary conversion. */
ScrStr *scr_str_substring(ScrStr *s, double start, double end) {
  ScrSidx *e = scr_sidx_for(s);
  double len16 = (double)scr_sidx_len(s, e);
  double a = scr_to_integer_or_infinity(start);
  double b = scr_to_integer_or_infinity(end);
  double fa = a < 0 ? 0 : a > len16 ? len16 : a;
  double fb = b < 0 ? 0 : b > len16 ? len16 : b;
  return fa < fb ? scr_str_slice_units(s, e, (size_t)fa, (size_t)fb)
                 : scr_str_slice_units(s, e, (size_t)fb, (size_t)fa);
}

bool scr_str_includes(ScrStr *s, ScrStr *needle) {
  if (scr_byte_find(s->data, s->len, needle->data, needle->len)) return true;
  return scr_needle_halves_pairs(needle) &&
         scr_str_unit_search(s, needle, 0, SCR_UNIT_FIRST) >= 0;
}

/* A needle ending in a lone high surrogate can match the first half of a
 * receiver pair (and one starting with a lone low surrogate the second). */
bool scr_str_starts_with(ScrStr *s, ScrStr *needle) {
  if (needle->len <= s->len && memcmp(s->data, needle->data, needle->len) == 0) return true;
  return scr_needle_halves_pairs(needle) && scr_str_unit_search(s, needle, 0, SCR_UNIT_AT) >= 0;
}

bool scr_str_ends_with(ScrStr *s, ScrStr *needle) {
  if (needle->len <= s->len &&
      memcmp(s->data + (s->len - needle->len), needle->data, needle->len) == 0)
    return true;
  if (!scr_needle_halves_pairs(needle)) return false;
  size_t len16 = scr_sidx_len(s, scr_sidx_for(s));
  size_t needle16 = scr_sidx_len(needle, scr_sidx_for(needle));
  return needle16 <= len16 && scr_str_unit_search(s, needle, len16 - needle16, SCR_UNIT_AT) >= 0;
}

static size_t scr_str_clamp_u16_position(double position, size_t len16) {
  double pos = scr_to_integer_or_infinity(position);
  return pos <= 0 ? 0 : pos >= (double)len16 ? len16 : (size_t)pos;
}

bool scr_str_starts_with_from(ScrStr *s, ScrStr *needle, double position) {
  if (needle->len == 0) return true;
  double pos = scr_to_integer_or_infinity(position);
  if (pos <= 0) return scr_str_starts_with(s, needle);
  if (pos >= (double)s->len || needle->len > s->len) return false;
  ScrSidx *e = scr_sidx_for(s);
  if (scr_needle_halves_pairs(needle)) {
    size_t len16 = scr_sidx_len(s, e);
    return pos <= (double)len16 &&
           scr_str_unit_search(s, needle, (size_t)pos, SCR_UNIT_AT) >= 0;
  }
  bool mid;
  size_t start_byte = scr_u16_to_byte_c(s, e, (size_t)pos, &mid);
  return !mid && needle->len <= s->len - start_byte &&
         memcmp(s->data + start_byte, needle->data, needle->len) == 0;
}

bool scr_str_ends_with_from(ScrStr *s, ScrStr *needle, double end_position) {
  if (needle->len == 0) return true;
  if (needle->len > s->len) return false;
  if (end_position >= (double)s->len) return scr_str_ends_with(s, needle);
  /* A second receiver lookup can evict the first receiver's entry. Resolve
   * the needle before borrowing the haystack entry for both conversions. */
  size_t needle16 = scr_sidx_len(needle, scr_sidx_for(needle));
  ScrSidx *e = scr_sidx_for(s);
  size_t len16 = scr_sidx_len(s, e);
  size_t end16 = scr_str_clamp_u16_position(end_position, len16);
  if (needle16 > end16) return false;
  if (scr_needle_halves_pairs(needle))
    return scr_str_unit_search(s, needle, end16 - needle16, SCR_UNIT_AT) >= 0;
  bool start_mid, end_mid;
  size_t start_byte = scr_u16_to_byte_c(s, e, end16 - needle16, &start_mid);
  size_t end_byte = scr_u16_to_byte_c(s, e, end16, &end_mid);
  return !start_mid && !end_mid && end_byte - start_byte == needle->len &&
         memcmp(s->data + start_byte, needle->data, needle->len) == 0;
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
  ScrSidx *e = scr_sidx_for(s);
  size_t len16 = scr_sidx_len(s, e);
  size_t from = scr_slice_boundary(scr_to_integer_or_infinity(start), len16);
  size_t to = scr_slice_boundary(scr_to_integer_or_infinity(end), len16);
  return scr_str_slice_units(s, e, from, to);
}

/* One slice() or substring() boundary in [0, length]: ToIntegerOrInfinity,
 * then slice's end-relative negative or substring's clamp. Conversion to an
 * integer truncates toward zero exactly like ToIntegerOrInfinity, so no
 * libm call is needed; NaN fails both comparisons and lands on 0, and a
 * negative fraction above -1 is -0, which slice treats as 0. */
static inline size_t scr_slice_unit(double v, size_t length, bool substring) {
  if (v >= 0) return v >= (double)length ? length : (size_t)v;
  if (substring || !(v > -(double)length)) return 0;
  long long unit = (long long)v; /* in (-length, 0] */
  return unit == 0 ? 0 : (size_t)((long long)length + unit);
}

/* slice()/substring() boundaries in UTF-16 units over the receiver's length. */
static void scr_str_slice_bounds(ScrStr *s, ScrSidx *e, double start, double end, bool substring,
                                 size_t *from_out, size_t *to_out) {
  size_t length = scr_sidx_len(s, e);
  size_t from = scr_slice_unit(start, length, substring);
  size_t to = scr_slice_unit(end, length, substring);
  if (substring && from > to) { size_t swap = from; from = to; to = swap; }
  *from_out = from;
  *to_out = to;
}

void scr_str_slice_range(ScrStr *s, double start, double end, bool substring,
                         ScrStringSlice *out) {
  ScrSidx *e = scr_sidx_for(s);
  size_t from, to;
  scr_str_slice_bounds(s, e, start, end, substring, &from, &to);
  out->start = from;
  out->length = to > from ? to - from : 0;
  out->split = 0;
  if (out->length) {
    bool first, last;
    (void)scr_u16_to_byte_c(s, e, from, &first);
    (void)scr_u16_to_byte_c(s, e, to, &last);
    out->split = (first ? 1u : 0u) | (last ? 2u : 0u);
  }
}

/* Fill a scratch buffer with `units` ASCII bytes (scr_str_is_scratch). */
static inline ScrStr *scr_str_scratch_fill(ScrStr *scratch, const char *data, size_t units) {
  scratch->rc = SIZE_MAX;
  scratch->len = units;
  scratch->cap = 0; /* below len: the scratch marker */
  scratch->ascii = 1;
#if SCR_STR_HASH_CACHE
  scratch->hash = 0;
#endif
  scr_copy_bytes(scratch->data, data, units);
  scratch->data[units] = '\0';
  return scratch;
}

ScrStr *scr_str_slice_scratch(ScrStr *s, double start, double end, bool substring,
                              ScrStr *scratch, size_t bytes) {
  size_t capacity = bytes - sizeof(ScrStr) - 1;
  if (__builtin_expect(s->ascii, 1)) {
    /* Units are bytes: no index entry, and the bounds are byte offsets. */
    size_t length = s->len;
    size_t from = scr_slice_unit(start, length, substring);
    size_t to = scr_slice_unit(end, length, substring);
    if (substring && from > to) { size_t swap = from; from = to; to = swap; }
    size_t units = to > from ? to - from : 0;
    /* Shorter results are interned statics. */
    if (units >= 2 && units <= capacity) return scr_str_scratch_fill(scratch, s->data + from, units);
    return scr_str_slice_units(s, NULL, from, to);
  }
  ScrSidx *e = scr_sidx_for(s);
  size_t from, to;
  scr_str_slice_bounds(s, e, start, end, substring, &from, &to);
  size_t units = to > from ? to - from : 0;
  if (units >= 2 && units <= capacity) {
    /* Equal unit and byte counts between two character boundaries prove
     * the span is ASCII: every other character takes more bytes than
     * UTF-16 units. Non-ASCII results keep the owned copy and its index. */
    bool first, last;
    size_t from_b = scr_u16_to_byte_c(s, e, from, &first);
    size_t to_b = scr_u16_to_byte_c(s, e, to, &last);
    if (!first && !last && to_b - from_b == units)
      return scr_str_scratch_fill(scratch, s->data + from_b, units);
  }
  return scr_str_slice_units(s, e, from, to);
}

ScrStr *scr_str_scratch_keep(ScrStr *s) {
  if (!scr_str_is_scratch(s)) return scr_str_retain(s);
  return scr_str_from_span_ascii(s->data, s->len);
}

double scr_str_slice_char_code_at(ScrStr *s, const ScrStringSlice *range, double index) {
  double unit = scr_to_integer_or_infinity(index);
  if (!(unit >= 0) || unit >= (double)range->length) return NAN;
  /* A boundary inside a pair keeps that half as a lone surrogate, which is
   * the receiver's own code unit at the same index. */
  return scr_str_char_code_at(s, (double)range->start + unit);
}

static ScrStr *scr_str_slice_units(ScrStr *s, ScrSidx *e,
                                    size_t from, size_t to) {
  if (from >= to) return scr_str_empty();
  if (s->ascii) {
    /* Identity mapping; callers clamp both bounds to the length. */
    if (from == 0 && to == s->len) return scr_str_retain(s);
    return scr_str_from_span_ascii(s->data + from, to - from);
  }
  if (from == 0 && to == e->u16len) return scr_str_retain(s);

  bool from_mid, to_mid;
  size_t from_b = scr_u16_to_byte_c(s, e, from, &from_mid);
  size_t to_b = scr_u16_to_byte_c(s, e, to, &to_mid);
  /* Both *_mid offsets point at the start of the split astral char; the
   * kept content is the whole chars strictly inside the boundaries. */
  size_t content_b = from_mid ? from_b + 4 : from_b;
  size_t content_len = to_b - content_b;

  if (!from_mid && !to_mid) {
    ScrStr *result = scr_str_from_span(s->data + from_b, content_len);
    /* Unit boundaries already prove the exact output length. Preserve it
     * instead of decoding a potentially megabyte-sized copy on .length.
     * Index checkpoints remain lazy and owned by the result's cache slot. */
    if (content_len >= SCR_SIDX_MIN_BYTES && !result->ascii)
      scr_sidx(result)->u16len = to - from;
    return result;
  }

  /* A split pair keeps the half inside the range as a lone surrogate: the
   * low half at the start, the high half at the end. */
  size_t total = content_len + (from_mid ? 3 : 0) + (to_mid ? 3 : 0);
  ScrStr *r = scr_str_alloc(total, total);
  size_t o = 0, adv;
  if (from_mid) o += scr_wtf8_put(r->data, scr_cp_low(scr_utf8_decode(s->data + from_b, &adv)));
  memcpy(r->data + o, s->data + content_b, content_len);
  o += content_len;
  if (to_mid) scr_wtf8_put(r->data + o, scr_cp_high(scr_utf8_decode(s->data + to_b, &adv)));
  r->data[total] = '\0';
  r->ascii = 0;
  return r;
}

ScrStr *scr_str_repeat(ScrStr *s, double count) {
  double n = scr_to_integer_or_infinity(count);
  if (n < 0 || (isinf(n) && n > 0)) {
    /* Node's catchable RangeError, with the count as ToString renders it
     * ("Invalid count value: -1", "... Infinity"). The caller checks the
     * pending exception; the empty result is never observed. */
    char num[32];
    scr_f64_to_str(count, num);
    char msg[64];
    int len = snprintf(msg, sizeof msg, "Invalid count value: %s", num);
    scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)len);
    return scr_str_empty();
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
  r->ascii = s->ascii;
  if (scr_wtf8_joins(s->data, s->len, s->data, s->len)) scr_str_fuse_surrogates(r);
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
  if (s->ascii) return (ScrStr *)&scr_ascii1[(unsigned char)s->data[(size_t)idx]];
  ScrSidx *e = scr_sidx(s);
  if (s->ascii || e->u16len == s->len) { /* all ASCII */
    return (ScrStr *)&scr_ascii1[(unsigned char)s->data[(size_t)idx]];
  }
  if (scr_sidx_units(s, e))
    return idx < (double)e->nunits ? scr_str_from_char_code_one(e->units[(size_t)idx]) : scr_str_empty();
  bool mid;
  size_t off = scr_u16_to_byte_c(s, e, (size_t)idx, &mid);
  if (off >= s->len) return scr_str_empty(); /* out of range */
  size_t adv;
  uint32_t cp = scr_utf8_decode(s->data + off, &adv);
  if (cp >= 0x10000) return scr_str_from_unit(mid ? scr_cp_low(cp) : scr_cp_high(cp));
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

/* Split owns a fresh array and appends only present string values. Fill an
 * available dense slot directly; ordinary push handles growth and the sparse
 * boundary. The array remains valid after every append, including RC audit. */

void scr_str_split_cursor_init(ScrSplitCursor *cursor, uint32_t limit) {
  cursor->offset = 0;
  cursor->remaining = limit;
  cursor->pending_unit = 0;
}

static ScrStr *scr_str_split_piece(const char *bytes, size_t len, ScrStr **scratch) {
  if (!scratch || len <= 4) return scr_str_from_span(bytes, len);
  ScrStr *piece = *scratch;
  if (piece && piece->rc == 1 && piece->cap >= len) {
    /* The scratch owner is the only remaining reference. Invalidate all
     * metadata before replacing bytes, just as unique concatenation does. */
    scr_short_forget(piece);
    scr_str_hash_forget(piece);
    scr_sidx_purge(piece);
    memcpy(piece->data, bytes, len);
    piece->len = len;
    piece->data[len] = '\0';
  } else {
    ScrStr *fresh = scr_str_alloc_raw(len, len < 64 ? 64 : len);
    memcpy(fresh->data, bytes, len);
    fresh->data[len] = '\0';
    *scratch = fresh;
    scr_str_release(piece);
    piece = fresh;
  }
  return scr_str_retain(piece);
}

/* Each half of an astral character is a lone surrogate piece, encoded into
 * the cursor (valid through the current step); `next` is the half still
 * owed (0 once both are out). The owed half's step counts here. */
static __attribute__((noinline)) const char *scr_str_split_unit(ScrSplitCursor *cursor,
                                                                uint32_t unit, uint32_t next,
                                                                size_t *len) {
  if (!next) cursor->remaining--;
  cursor->pending_unit = next;
  scr_wtf8_put(cursor->unit, unit);
  *len = 3;
  return cursor->unit;
}

/* Both eager and loop consumers use the same boundary state machine.
 * Eager consumers select the unit/substring path once before their loop. */
static inline __attribute__((always_inline)) const char *
scr_str_split_span(ScrStr *s, ScrStr *sep, ScrSplitCursor *cursor, bool units, size_t *len) {
  if (cursor->remaining == 0 || cursor->offset > s->len) return NULL;
  if (units) {
    if (cursor->pending_unit) return scr_str_split_unit(cursor, cursor->pending_unit, 0, len);
    if (cursor->offset == s->len) return NULL;
    size_t start = cursor->offset, adv;
    uint32_t cp = scr_utf8_decode(s->data + start, &adv);
    cursor->offset += adv;
    cursor->remaining--;
    if (cp >= 0x10000) return scr_str_split_unit(cursor, scr_cp_high(cp), scr_cp_low(cp), len);
    *len = adv;
    return s->data + start;
  }
  size_t start = cursor->offset;
  const char *found = scr_byte_find(s->data + start, s->len - start,
                                    sep->data, sep->len);
  size_t end = found ? (size_t)(found - s->data) : s->len;
  /* String allocations reserve the header and terminator, so len + 1
   * cannot overflow. This sentinel includes a final empty trailing piece. */
  cursor->offset = found ? end + sep->len : s->len + 1;
  cursor->remaining--;
  *len = end - start;
  return s->data + start;
}

/* The source snapshot owns these bytes through the current iteration.
 * A consumer that stores or otherwise exposes the piece materializes it
 * with ordinary string ownership instead. */
const char *scr_str_split_cursor_span(ScrStr *s, ScrStr *sep, ScrSplitCursor *cursor,
                                     size_t *length) {
  return scr_str_split_span(s, sep, cursor, sep->len == 0, length);
}

ScrStr *scr_str_split_materialize(const char *bytes, size_t length, ScrStr **scratch) {
  return scr_str_split_piece(bytes, length, scratch);
}

ScrStr *scr_str_split_cursor_next(ScrStr *s, ScrStr *sep, ScrSplitCursor *cursor,
                                  ScrStr **scratch) {
  size_t len;
  const char *bytes = scr_str_split_span(s, sep, cursor, sep->len == 0, &len);
  if (!bytes) return NULL;
  return scr_str_split_piece(bytes, len, scratch);
}

/* Move a bounded batch of pieces into array storage in one operation.
 * This avoids a second separator scan and preserves sparse overflow. */
static void scr_str_split_fill(ScrArr *out, ScrStr *s, ScrStr *sep,
                               ScrSplitCursor *cursor, bool units) {
  uint64_t slots[64];
  if (units && s->ascii) {
    /* Every unit of an ASCII receiver is an interned one-character string. */
    while (cursor->remaining && cursor->offset < s->len) {
      size_t count = 0;
      while (count < 64 && cursor->remaining && cursor->offset < s->len) {
        slots[count++] =
            (uint64_t)(uintptr_t)&scr_ascii1[(unsigned char)s->data[cursor->offset++]];
        cursor->remaining--;
      }
      scr_arr_push_many(out, count, slots);
    }
    return;
  }
  for (;;) {
    size_t count = 0, len;
    const char *bytes;
    while (count < 64 && (bytes = scr_str_split_span(s, sep, cursor, units, &len))) {
      ScrStr *piece = scr_str_from_span(bytes, len);
      slots[count++] = (uint64_t)(uintptr_t)piece;
    }
    if (count) scr_arr_push_many(out, count, slots);
    if (count < 64) return;
  }
}

ScrArr *scr_str_split_limit(ScrStr *s, ScrStr *sep, double limit_num) {
  uint32_t limit = scr_to_uint32(limit_num);
  /* An empty separator yields one piece per UTF-16 unit: size it once. */
  size_t pieces = 0;
  if (sep->len == 0) {
    pieces = s->ascii ? s->len : scr_sidx_len(s, scr_sidx(s));
    if (pieces > limit) pieces = limit;
  }
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, pieces);
  ScrSplitCursor cursor;
  scr_str_split_cursor_init(&cursor, limit);
  if (sep->len == 0) scr_str_split_fill(out, s, sep, &cursor, true);
  else scr_str_split_fill(out, s, sep, &cursor, false);
  return out;
}

ScrArr *scr_str_split(ScrStr *s, ScrStr *sep) {
  return scr_str_split_limit(s, sep, 4294967295.0);
}

/* ── replace / replaceAll with a string search value ──────────────────
 * One forward scan over the subject bytes. A nonempty needle is canonical
 * WTF-8, so every byte match starts on a character boundary and is a
 * UTF-16 match; the substitution spans are byte ranges of the subject. */

/* GetSubstitution with no captures: $$, $&, $` and $' expand. With no
 * capture groups and no named groups, $n and $<name> stay literal, as does
 * every other '$'. */
static void scr_replace_template(ScrJsonBuf *b, const char *before, size_t before_len,
                                 const char *match, size_t match_len, const char *after,
                                 size_t after_len, const ScrStr *rep) {
  size_t i = 0;
  while (i < rep->len) {
    const char *dollar = memchr(rep->data + i, '$', rep->len - i);
    size_t stop = dollar ? (size_t)(dollar - rep->data) : rep->len;
    scr_jb_write(b, rep->data + i, stop - i);
    if (!dollar) return;
    i = stop;
    char next = i + 1 < rep->len ? rep->data[i + 1] : '\0';
    if (i + 1 < rep->len && (next == '$' || next == '&' || next == '`' || next == '\'')) {
      if (next == '$') scr_jb_putc(b, '$');
      else if (next == '&') scr_jb_write(b, match, match_len);
      else if (next == '`') scr_jb_write(b, before, before_len);
      else scr_jb_write(b, after, after_len);
      i += 2;
    } else {
      scr_jb_putc(b, '$');
      i += 1;
    }
  }
}

const char *scr_str_find_bytes(const char *hay, size_t hay_len, const char *needle,
                               size_t needle_len) {
  return scr_byte_find(hay, hay_len, needle, needle_len);
}

ScrStr *scr_str_replace_bytes(ScrStr *s, const char *pat, size_t plen, ScrStr *rep, bool all) {
  const char *end = s->data + s->len;
  const char *hit = scr_byte_find(s->data, s->len, pat, plen);
  if (!hit) return scr_str_retain(s);
  if (memchr(rep->data, '$', rep->len) != NULL) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    const char *from = s->data;
    while (hit) {
      size_t pos = (size_t)(hit - s->data);
      scr_jb_write(&b, from, (size_t)(hit - from));
      scr_replace_template(&b, s->data, pos, hit, plen, hit + plen, s->len - pos - plen, rep);
      from = hit + plen;
      if (!all) break;
      hit = scr_byte_find(from, (size_t)(end - from), pat, plen);
    }
    scr_jb_write(&b, from, (size_t)(end - from));
    return scr_jb_finish(&b);
  }
  /* A plain replacement: one pass into a block with room for a few
   * growing hits; a longer result grows geometrically, and a result well
   * below its block is trimmed. */
  size_t grow = rep->len > plen ? rep->len - plen : 0;
  size_t cap = s->len + (grow < 64 ? 4 * grow : grow) + 16;
  if (cap > SCR_STR_MAX_CAP) cap = SCR_STR_MAX_CAP;
  ScrStr *out = scr_str_alloc_raw(0, cap);
  cap = out->cap;
  size_t used = 0;
  const char *from = s->data;
  /* A seam can complete a surrogate pair only where a piece starts with a
   * lone low surrogate: the replacement, or the subject after a match. */
  bool joins = false;
  for (;;) {
    size_t gap = hit ? (size_t)(hit - from) : (size_t)(end - from);
    size_t need = gap + (hit ? rep->len : 0);
    if (need > cap - used) {
      if (need > SCR_STR_MAX_CAP - used) scr_oom();
      size_t want = cap * 2 < used + need + (size_t)(end - from) ? used + need + (size_t)(end - from)
                                                                 : cap * 2;
      if (want > SCR_STR_MAX_CAP) want = SCR_STR_MAX_CAP;
      out->len = used;
      out = scr_str_regrow(out, want);
      cap = want;
    }
    scr_copy_bytes(out->data + used, from, gap);
    used += gap;
    if (!hit) break;
    if (rep->len) joins |= scr_wtf8_joins(out->data, used, rep->data, rep->len);
    scr_copy_bytes(out->data + used, rep->data, rep->len);
    used += rep->len;
    from = hit + plen;
    joins |= (unsigned char)*from == 0xED;
    hit = all ? scr_byte_find(from, (size_t)(end - from), pat, plen) : NULL;
  }
  out->len = used;
  if (cap - used > used / 4 + 64) out = scr_str_regrow(out, used);
  out->data[used] = '\0';
  scr_str_hash_forget(out);
  if (joins && scr_wtf8_any()) scr_str_fuse_surrogates(out);
  else if (s->ascii && rep->ascii) scr_str_note_ascii(out);
  return out;
}

/* The first byte at or after `i` that is one of the replaced characters
 * (`which` maps them to k + 1), or len. Up to eight characters are tested
 * eight bytes at a time. */
static size_t scr_replace_chars_next(const char *p, size_t i, size_t len, const uint8_t *which,
                                     const char *chars, size_t n) {
  if (n <= 8) {
    const uint64_t ones = UINT64_C(0x0101010101010101);
    const uint64_t highs = UINT64_C(0x8080808080808080);
    for (; len - i >= 8; i += 8) {
      uint64_t w;
      memcpy(&w, p + i, 8);
      uint64_t hit = 0;
      for (size_t k = 0; k < n; k++) {
        uint64_t x = w ^ (ones * (unsigned char)chars[k]);
        hit |= (x - ones) & ~x & highs;
      }
      if (hit) break;
    }
  }
  for (; i < len; i++) {
    unsigned char c = (unsigned char)p[i];
    if (c < 0x80 && which[c]) return i;
  }
  return len;
}

ScrStr *scr_str_replace_chars(ScrStr *s, ScrStr *chars, ScrStr *texts) {
  enum { MAX = 16 };
  size_t n = chars->len < MAX ? chars->len : MAX;
  uint8_t which[128] = { 0 };
  const char *text[MAX];
  size_t text_len[MAX];
  size_t grow = 0;
  bool ascii = s->ascii;
  const char *t = texts->data, *t_end = texts->data + texts->len;
  for (size_t k = 0; k < n; k++) {
    const char *stop = memchr(t, '\0', (size_t)(t_end - t));
    if (!stop) stop = t_end;
    text[k] = t;
    text_len[k] = (size_t)(stop - t);
    if (text_len[k] > grow) grow = text_len[k];
    if (ascii && !scr_bytes_all_ascii(t, text_len[k])) ascii = false;
    which[(unsigned char)chars->data[k] & 0x7F] = (uint8_t)(k + 1);
    t = stop < t_end ? stop + 1 : t_end;
  }
  const char *p = s->data;
  size_t len = s->len;
  size_t i = scr_replace_chars_next(p, 0, len, which, chars->data, n);
  if (i == len) return scr_str_retain(s);
  grow = grow > 1 ? grow - 1 : 0;
  size_t cap = len + (grow < 64 ? 4 * grow : grow) + 16;
  if (cap > SCR_STR_MAX_CAP) cap = SCR_STR_MAX_CAP;
  ScrStr *out = scr_str_alloc_raw(0, cap);
  cap = out->cap;
  size_t used = 0, from = 0;
  /* As in scr_str_replace_bytes: a seam can complete a surrogate pair. */
  bool joins = false;
  for (;;) {
    size_t gap = i - from;
    size_t k = i < len ? (size_t)which[(unsigned char)p[i]] - 1 : 0;
    size_t need = gap + (i < len ? text_len[k] : 0);
    if (need > cap - used) {
      if (need > SCR_STR_MAX_CAP - used) scr_oom();
      size_t want = cap * 2 < used + need + (len - from) ? used + need + (len - from) : cap * 2;
      if (want > SCR_STR_MAX_CAP) want = SCR_STR_MAX_CAP;
      out->len = used;
      out = scr_str_regrow(out, want);
      cap = want;
    }
    scr_copy_bytes(out->data + used, p + from, gap);
    used += gap;
    if (i == len) break;
    if (text_len[k]) joins |= scr_wtf8_joins(out->data, used, text[k], text_len[k]);
    scr_copy_bytes(out->data + used, text[k], text_len[k]);
    used += text_len[k];
    from = i + 1;
    joins |= (unsigned char)p[from] == 0xED;
    i = scr_replace_chars_next(p, from, len, which, chars->data, n);
  }
  out->len = used;
  if (cap - used > used / 4 + 64) out = scr_str_regrow(out, used);
  out->data[used] = '\0';
  scr_str_hash_forget(out);
  if (joins && scr_wtf8_any()) scr_str_fuse_surrogates(out);
  else if (ascii) scr_str_note_ascii(out);
  return out;
}

ScrStr *scr_str_replace_literal(ScrStr *s, ScrStr *search, ScrStr *rep, bool all) {
  if (search->len) return scr_str_replace_bytes(s, search->data, search->len, rep, all);
  ScrJsonBuf b;
  scr_jb_init(&b);
  if (!all) {
    scr_replace_template(&b, s->data, 0, s->data, 0, s->data, s->len, rep);
    scr_jb_write(&b, s->data, s->len);
    return scr_jb_finish(&b);
  }
  /* The empty needle matches at every UTF-16 position, including between
   * the halves of a surrogate pair; those spans follow slice's contract. */
  size_t len16 = (size_t)scr_str_utf16_len(s);
  if (len16 == s->len) {
    for (size_t k = 0; k <= s->len; k++) {
      scr_replace_template(&b, s->data, k, s->data + k, 0, s->data + k, s->len - k, rep);
      if (k < s->len) scr_jb_putc(&b, s->data[k]);
    }
    return scr_jb_finish(&b);
  }
  for (size_t k = 0; k <= len16; k++) {
    ScrStr *before = scr_str_slice(s, 0, (double)k);
    ScrStr *after = scr_str_slice(s, (double)k, (double)len16);
    scr_replace_template(&b, before->data, before->len, after->data, 0, after->data, after->len,
                         rep);
    scr_str_release(before);
    scr_str_release(after);
    if (k < len16) {
      ScrStr *unit = scr_str_slice(s, (double)k, (double)(k + 1));
      scr_jb_put_str(&b, unit);
      scr_str_release(unit);
    }
  }
  return scr_jb_finish(&b);
}

/* StringPad (ECMA-262 22.1.3.16/17): target length in UTF-16 units, the
 * filler built from whole repetitions of `fill` plus a truncated prefix.
 * A target at or below the length (or an empty fill) returns the receiver
 * unchanged. A truncation that would split an astral char in the fill
 * keeps its high half as a lone surrogate, as JS does. Sizes beyond what malloc can satisfy abort (the
 * repeat() policy; JS's RangeError fires around 2^29 units). Borrows both;
 * returns +1. */
static ScrStr *scr_pad_impl(ScrStr *s, double maxLength, ScrStr *fill,
                             bool at_start) {
  double target = scr_to_integer_or_infinity(maxLength);
  size_t len16 = scr_sidx_len(s, scr_sidx_for(s));
  if (!(target > (double)len16) || fill->len == 0) return scr_str_retain(s);
  /* Reject pad sizes malloc could not satisfy before the double→size_t
   * conversion can overflow (each unit is at most 3 bytes here: BMP chars
   * and lone surrogates; astral chars are 4 bytes for 2 units). */
  if (target > (double)((SIZE_MAX - sizeof(ScrStr) - 1) / 4)) scr_oom();
  size_t pad16 = (size_t)target - len16;
  size_t fill16 = scr_sidx_len(fill, scr_sidx_for(fill));
  size_t reps = pad16 / fill16, rem16 = pad16 % fill16;
  /* The truncated prefix of fill: whole chars while they fit in rem16
   * units; a final astral char that doesn't fit contributes its high
   * surrogate. */
  size_t prefix_b = 0, prefix_units = 0;
  bool prefix_half = false;
  while (prefix_units < rem16) {
    size_t seq = scr_utf8_seq_len((unsigned char)fill->data[prefix_b]);
    size_t w = seq == 4 ? 2 : 1;
    if (prefix_units + w > rem16) { /* astral char split by the truncation */
      prefix_half = true;
      prefix_units += 1;
      break;
    }
    prefix_b += seq;
    prefix_units += w;
  }
  size_t pad_b = reps * fill->len + prefix_b + (prefix_half ? 3 : 0);
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
  if (prefix_half) {
    size_t adv;
    w += scr_wtf8_put(w, scr_cp_high(scr_utf8_decode(fill->data + prefix_b, &adv)));
  }
  memcpy(at_start ? w : r->data, s->data, s->len);
  r->data[total] = '\0';
  /* Only a piece that starts with a lone low surrogate can complete a
   * pair across a seam: the fill (after a fill or the receiver) or the
   * receiver (after a fill ending in a high surrogate). */
  if (scr_wtf8_any() &&
      ((unsigned char)fill->data[0] == 0xED || (unsigned char)s->data[0] == 0xED))
    scr_str_fuse_surrogates(r);
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

/* One fold of V8's generic-radix loop: v * multiplier + part. Node's V8 is
 * compiled with the C++ compiler's default floating-point contraction,
 * which fuses this multiply-add into one rounding on arm64 and keeps two
 * roundings on x86-64, so Node answers long inputs differently on the two
 * architectures (parseInt("9007199254740993", 36) is 1.9896986116031812e+24
 * on arm64 and 1.9896986116031807e+24 on x64). Each form is written out so
 * the result matches the same architecture's Node under any contraction
 * setting this file is compiled with. */
static inline double scr_radix_fold(double v, uint32_t multiplier, uint32_t part) {
#if defined(__aarch64__)
  return fma(v, (double)multiplier, (double)part);
#else
#ifdef __clang__
#pragma clang fp contract(off)
#endif
  return v * (double)multiplier + (double)part;
#endif
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
     * fold with one double multiply-add per chunk (scr_radix_fold) — the
     * rounding of each fold IS the observable Node behavior. */
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
      v = scr_radix_fold(v, multiplier, part);
    } while (!done);
    return v;
  }
  /* u64 fast path: exact while the accumulator fits. Stopping as soon as
   * another digit might overflow is conservative (the bignum below takes
   * over exactly), so the bound is computed once instead of dividing per
   * digit. */
  uint64_t acc = 0;
  size_t i = 0;
  const uint64_t limit = (UINT64_MAX - (uint64_t)(radix - 1)) / (uint64_t)radix;
  for (; i < n; i++) {
    if (acc > limit) break;
    acc = acc * (uint64_t)radix + (uint64_t)scr_digit_value(p[i]);
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
  return scr_parse_int_bytes(s->data, s->len, radix);
}

double scr_parse_int_bytes(const char *p, size_t n, double radix) {
  /* parseInt(digits, 10) of a short all-digit string (a numeric field or
   * regex capture): exact in a u64 and in a double, with no whitespace,
   * sign or prefix to resolve. Anything else takes the full algorithm. */
  double fast;
  if (radix == 10 && scr_parse_int_short_digits(p, n, &fast)) return fast;
  /* Integral radixes in range are their own ToInt32. */
  double r32 = radix >= 2 && radix <= 36 && radix == (double)(int)radix ? radix
                                                                       : scr_to_int32_d(radix);
  size_t i = 0;
  while (i < n) {
    unsigned char c = (unsigned char)p[i];
    if (c > 0x20 && c < 0x80) break; /* ASCII non-whitespace */
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
    unsigned char c = (unsigned char)p[i];
    if (c > 0x20 && c < 0x80) break; /* ASCII non-whitespace */
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
  double fast;
  if (scr_decimal_fast(p + start, span, &fast)) return fast;
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
  return scr_bytes_to_number(s->data, s->len);
}

double scr_bytes_to_number(const char *p, size_t len) {
  size_t b = 0, e = len;
  while (b < e) {
    unsigned char c = (unsigned char)p[b];
    if (c > 0x20 && c < 0x80) break; /* ASCII non-whitespace */
    size_t adv;
    uint32_t cp = scr_utf8_decode(p + b, &adv);
    if (!scr_is_js_whitespace(cp)) break;
    b += adv;
  }
  while (e > b) {
    unsigned char c = (unsigned char)p[e - 1];
    if (c > 0x20 && c < 0x80) break; /* ASCII non-whitespace */
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
   * | . digits) ([eE][+-]?digits)? — nothing before, nothing after. The
   * digit grammar and Clinger's exact fast path share one scan
   * (scr_decimal_scan, scr_number.c); valid spans it cannot convert exactly
   * fall through to strtod. */
  size_t i = (p[0] == '+' || p[0] == '-') ? 1 : 0;
  if (n - i == 8 && memcmp(p + i, "Infinity", 8) == 0) {
    return p[0] == '-' ? -(double)INFINITY : (double)INFINITY;
  }
  double fast;
  int scanned = scr_decimal_scan(p, n, &fast);
  if (scanned < 0) return NAN; /* ".", "1e", "1.2.3", "12px", "1_000" */
  if (scanned > 0) return fast;
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
  return scr_str_new_ascii(buf, len); /* number text is always ASCII */
}

/* ── encodeURIComponent / encodeURI ───────────────────────────────────
 * ECMA-262 Encode() over the WTF-8 storage. The spec transcodes UTF-16
 * to UTF-8 and percent-encodes every byte outside the unescaped set —
 * storage without lone surrogates already IS that UTF-8, so the walk is
 * byte-wise; a lone surrogate is the spec's URIError arm, checked once
 * up front. Unescaped sets are the
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

static void scr_uri_malformed(void);

/* Encode()'s URIError: an unpaired surrogate has no UTF-8 encoding. */
static bool scr_uri_unencodable(const ScrStr *s) {
  if (!scr_str_has_surrogate(s)) return false;
  scr_uri_malformed();
  return true;
}

static ScrStr *scr_encode_uri_impl(ScrStr *s, bool keep_reserved) {
  if (scr_uri_unencodable(s)) return scr_str_empty();
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
 * A string is ill-formed exactly when its storage holds a lone surrogate;
 * toWellFormed replaces each with U+FFFD, which has the same length. A
 * proven-ASCII receiver answers without a scan. */
bool scr_str_is_well_formed(ScrStr *s) { return !scr_str_has_surrogate(s); }

ScrStr *scr_str_to_well_formed(ScrStr *s) {
  if (s->ascii || !scr_wtf8_any()) return scr_str_retain(s);
  const char *hit = scr_wtf8_find_surrogate(s->data, s->len);
  if (!hit) return scr_str_retain(s);
  size_t at = (size_t)(hit - s->data);
  ScrStr *r = scr_str_new(s->data, s->len);
  scr_wtf8_replace_surrogates(r->data + at, s->len - at);
  return r;
}

/* Immortal interned booleans (same layout trick the emitter uses for
 * string literals). */
static const struct { size_t rc; size_t len; size_t cap; char data[5]; }
    scr_lit_true = {SIZE_MAX, 4, SCR_STR_CAP_WORD(4, 0, 1), "true"};
static const struct { size_t rc; size_t len; size_t cap; char data[6]; }
    scr_lit_false = {SIZE_MAX, 5, SCR_STR_CAP_WORD(5, 0, 1), "false"};

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
  if (s->ascii) return (ScrStr *)&scr_ascii1[(unsigned char)s->data[(size_t)idx]];
  ScrSidx *e = scr_sidx(s);
  if (s->ascii || e->u16len == s->len) { /* all ASCII */
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
  if (scr_uri_unencodable(s)) return scr_str_empty();
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

ScrStr *scr_qs_encode_str(const ScrStr *s, const signed char no_escape[128]) {
  static const char hex[] = "0123456789ABCDEF";
  /* UTF-16 code units: each 4-byte sequence is a surrogate pair. */
  uint16_t *units = malloc((s->len ? s->len : 1) * sizeof *units);
  if (!units) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  for (size_t i = 0; i < s->len;) {
    unsigned char c = (unsigned char)s->data[i];
    uint32_t cp;
    size_t len = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
    if (len > s->len - i) len = s->len - i;
    if (len == 1) cp = c;
    else if (len == 2) cp = ((uint32_t)(c & 0x1F) << 6) | ((unsigned char)s->data[i + 1] & 0x3F);
    else if (len == 3)
      cp = ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)((unsigned char)s->data[i + 1] & 0x3F) << 6) |
           ((unsigned char)s->data[i + 2] & 0x3F);
    else
      cp = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)((unsigned char)s->data[i + 1] & 0x3F) << 12) |
           ((uint32_t)((unsigned char)s->data[i + 2] & 0x3F) << 6) | ((unsigned char)s->data[i + 3] & 0x3F);
    i += len;
    if (cp >= 0x10000) {
      units[n++] = (uint16_t)(0xD800 + ((cp - 0x10000) >> 10));
      units[n++] = (uint16_t)(0xDC00 + ((cp - 0x10000) & 0x3FF));
    } else {
      units[n++] = (uint16_t)cp;
    }
  }
  ScrJsonBuf out;
  scr_jb_init(&out);
  char esc[12];
  for (size_t i = 0; i < n; i++) {
    uint32_t c = units[i];
    size_t k = 0;
    if (c < 0x80) {
      if (no_escape[c] == 1) {
        scr_jb_putc(&out, (char)c);
        continue;
      }
      esc[k++] = '%', esc[k++] = hex[c >> 4], esc[k++] = hex[c & 0xF];
    } else {
      uint8_t bytes[4];
      size_t nb;
      if (c < 0x800) {
        bytes[0] = (uint8_t)(0xC0 | (c >> 6)), bytes[1] = (uint8_t)(0x80 | (c & 0x3F));
        nb = 2;
      } else if (c < 0xD800 || c >= 0xE000) {
        bytes[0] = (uint8_t)(0xE0 | (c >> 12)), bytes[1] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
        bytes[2] = (uint8_t)(0x80 | (c & 0x3F));
        nb = 3;
      } else {
        if (++i >= n) {
          free(units);
          scr_str_release(scr_jb_finish(&out));
          scr_throw_error_msg_code(SCR_ERR_URI, "URI malformed", 13, "ERR_INVALID_URI");
          return NULL;
        }
        c = 0x10000 + (((c & 0x3FF) << 10) | (units[i] & 0x3FF));
        bytes[0] = (uint8_t)(0xF0 | (c >> 18)), bytes[1] = (uint8_t)(0x80 | ((c >> 12) & 0x3F));
        bytes[2] = (uint8_t)(0x80 | ((c >> 6) & 0x3F)), bytes[3] = (uint8_t)(0x80 | (c & 0x3F));
        nb = 4;
      }
      for (size_t b = 0; b < nb; b++) esc[k++] = '%', esc[k++] = hex[bytes[b] >> 4], esc[k++] = hex[bytes[b] & 0xF];
    }
    scr_jb_write_utf8(&out, esc, k);
  }
  free(units);
  return scr_jb_finish(&out);
}

/* querystring.escape: the component encoder, with Node's encodeStr
 * surrogate handling when the string holds a lone surrogate. */
ScrStr *scr_qs_escape(ScrStr *s) {
  if (scr_str_has_surrogate(s)) {
    /* lib/querystring.js noEscape: the component unreserved set. */
    static const signed char unreserved[128] = {
        ['!'] = 1, ['\''] = 1, ['('] = 1, [')'] = 1, ['*'] = 1, ['-'] = 1, ['.'] = 1, ['_'] = 1, ['~'] = 1,
        ['0'] = 1, ['1'] = 1, ['2'] = 1, ['3'] = 1, ['4'] = 1, ['5'] = 1, ['6'] = 1, ['7'] = 1, ['8'] = 1,
        ['9'] = 1, ['A'] = 1, ['B'] = 1, ['C'] = 1, ['D'] = 1, ['E'] = 1, ['F'] = 1, ['G'] = 1, ['H'] = 1,
        ['I'] = 1, ['J'] = 1, ['K'] = 1, ['L'] = 1, ['M'] = 1, ['N'] = 1, ['O'] = 1, ['P'] = 1, ['Q'] = 1,
        ['R'] = 1, ['S'] = 1, ['T'] = 1, ['U'] = 1, ['V'] = 1, ['W'] = 1, ['X'] = 1, ['Y'] = 1, ['Z'] = 1,
        ['a'] = 1, ['b'] = 1, ['c'] = 1, ['d'] = 1, ['e'] = 1, ['f'] = 1, ['g'] = 1, ['h'] = 1, ['i'] = 1,
        ['j'] = 1, ['k'] = 1, ['l'] = 1, ['m'] = 1, ['n'] = 1, ['o'] = 1, ['p'] = 1, ['q'] = 1, ['r'] = 1,
        ['s'] = 1, ['t'] = 1, ['u'] = 1, ['v'] = 1, ['w'] = 1, ['x'] = 1, ['y'] = 1, ['z'] = 1,
    };
    ScrStr *out = scr_qs_encode_str(s, unreserved);
    return out ? out : scr_str_empty();
  }
  return scr_str_encode_uri_component(s);
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
static ScrStr *scr_str_decode_uri_try(ScrStr *s, bool reserved) {
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
      if (reserved && b0 != 0 && strchr(";/?:@&=+$,#", b0)) {
        memcpy(out->data + w, p + i - 3, 3);
        w += 3;
        continue;
      }
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

ScrStr *scr_str_decode_uri_component_try(ScrStr *s) {
  return scr_str_decode_uri_try(s, false);
}

ScrStr *scr_str_decode_uri(ScrStr *s) {
  ScrStr *out = scr_str_decode_uri_try(s, true);
  if (!out) scr_uri_malformed();
  return out;
}

ScrStr *scr_str_decode_uri_component(ScrStr *s) {
  ScrStr *out = scr_str_decode_uri_component_try(s);
  if (!out) {
    scr_uri_malformed();
    return NULL;
  }
  return out;
}

/* ── String.prototype.localeCompare (one argument) ─────────────────────
 * Node's default collation is ICU's root locale. scr_collation_data.h
 * (scripts/gen-collation-table.mjs, verified against the pinned Node)
 * carries its collation elements for the Latin repertoire: ASCII, Latin-1
 * Supplement, Latin Extended-A and the combining diacritics. Strings
 * entirely inside it compare exactly as Node does: canonical decomposition
 * and mark reordering, then primaries (letters before case and accents:
 * "a" < "B"), secondaries (accents), tertiaries (case). A string with any
 * other code point falls back to code-point order (the documented limit;
 * `scriptc coverage` reports such literals as SC6003). */
typedef struct {
  ScrCollElem *e;
  size_t n, cap;
  ScrCollElem inline_buf[64];
} ScrCollBuf;

/* ASCII text: every covered byte is one base collation element (no
 * expansion, no combining class), so the levels compare byte by byte with
 * no element lists. Built once per thread from the generated table; `ok`
 * is false for bytes the table leaves uncovered (C0 controls other than
 * TAB..CR, DEL, and every byte >= 0x80). */
typedef struct {
  uint16_t p;
  uint8_t s, t;
  bool ok;
} ScrCollAscii;
static SCR_TL ScrCollAscii scr_coll_ascii_table[128];
/* Covered bytes that are part of no contraction: one element each. */
static SCR_TL bool scr_coll_ascii_plain[128];
static SCR_TL bool scr_coll_ascii_ready;
/* The same table for the single-pass primary comparison: covered bytes as
 * a bit set, their primaries, and whether any covered byte has a zero
 * primary (then the level-0 skip makes the byte-by-byte pass inexact). */
static SCR_TL uint64_t scr_coll_ascii_mask[2];
static SCR_TL uint16_t scr_coll_ascii_primaries[128];
/* Which byte-by-byte ASCII paths are exact: a contraction of two ASCII code
 * points turns both off, and a covered byte with a zero primary turns off
 * the single-pass primary comparison. */
static SCR_TL bool scr_coll_ascii_one_pass;
static SCR_TL bool scr_coll_ascii_levels;
/* The covered ASCII bytes are exactly TAB..CR and 0x20..0x7E: the
 * single-pass comparison then checks eight bytes at a time. */
static SCR_TL bool scr_coll_ascii_printable;
/* Code points below 0x180 that start a contraction, as a bit set; higher
 * ones are looked up in scr_coll_contractions. */
#define SCR_COLL_BITS_LIMIT 0x180
static SCR_TL uint64_t scr_coll_starts_bits[SCR_COLL_BITS_LIMIT / 64];
/* scr_coll_scan's answer for one code point below SCR_COLL_SCAN_LIMIT
 * (the table's ranges through the combining marks; U+2044 FRACTION SLASH,
 * above it, is looked up): 0 for plain covered, 1 for covered
 * but needing the element lists (a mark with a primary weight, or the end
 * of a contraction), 2 for uncovered. */
#define SCR_COLL_SCAN_LIMIT 0x370
static SCR_TL uint8_t scr_coll_scan_class[SCR_COLL_SCAN_LIMIT];

static __attribute__((noinline)) void scr_coll_ascii_init(void) {
  bool zero_primary = false, contraction = false, in_contraction[128] = {false};
  for (uint32_t c = 0; c < 128; c++) {
    const ScrCollEntry *entry = scr_coll_lookup(c);
    bool ok = entry != NULL && entry->n == 1 && entry->e[0].ccc == 0;
    scr_coll_ascii_table[c] = (ScrCollAscii){ok ? entry->e[0].p : 0, ok ? entry->e[0].s : 0,
                                             ok ? entry->e[0].t : 0, ok};
    if (ok) scr_coll_ascii_mask[c >> 6] |= UINT64_C(1) << (c & 63);
    scr_coll_ascii_primaries[c] = ok ? entry->e[0].p : 0;
    if (ok && entry->e[0].p == 0) zero_primary = true;
  }
  for (size_t k = 0; k < SCR_COLL_CONTRACTIONS; k++) {
    uint32_t first = scr_coll_contractions[k].first, second = scr_coll_contractions[k].second;
    if (first < 128) in_contraction[first] = true;
    if (second < 128) in_contraction[second] = true;
    if (first < 128 && second < 128) contraction = true;
    if (first < SCR_COLL_BITS_LIMIT) scr_coll_starts_bits[first >> 6] |= UINT64_C(1) << (first & 63);
  }
  for (uint32_t c = 0; c < 128; c++) scr_coll_ascii_plain[c] = scr_coll_ascii_table[c].ok && !in_contraction[c];
  scr_coll_ascii_one_pass = !zero_primary && !contraction;
  scr_coll_ascii_levels = !contraction;
  uint64_t printable[2] = {0, 0};
  for (uint32_t c = 0; c < 128; c++)
    if ((c >= 0x09 && c <= 0x0d) || (c >= 0x20 && c <= 0x7e)) printable[c >> 6] |= UINT64_C(1) << (c & 63);
  scr_coll_ascii_printable = scr_coll_ascii_mask[0] == printable[0] && scr_coll_ascii_mask[1] == printable[1];
  for (uint32_t c = 0; c < SCR_COLL_SCAN_LIMIT; c++) {
    const ScrCollEntry *entry = scr_coll_lookup(c);
    uint8_t klass = entry == NULL || entry->n == 255 ? 2 : 0;
    for (uint8_t i = 0; klass == 0 && i < entry->n; i++)
      if (entry->e[i].ccc != 0 && entry->e[i].p != 0) klass = 1;
    for (size_t k = 0; klass == 0 && k < SCR_COLL_CONTRACTIONS; k++)
      if (scr_coll_contractions[k].second == c) klass = 1;
    scr_coll_scan_class[c] = klass;
  }
  scr_coll_ascii_ready = true;
}

/* The per-thread tables, built on first use. */
static inline __attribute__((always_inline)) const ScrCollAscii *scr_coll_ascii(void) {
  if (__builtin_expect(!scr_coll_ascii_ready, 0)) scr_coll_ascii_init();
  return scr_coll_ascii_table;
}

static inline __attribute__((always_inline)) uint32_t scr_coll_decode(const unsigned char **pp,
                                                                  const unsigned char *end) {
  const unsigned char *p = *pp;
  uint32_t c = *p++;
  if (c >= 0x80) {
    int extra = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : 1;
    c &= extra == 3 ? 0x07 : extra == 2 ? 0x0f : 0x1f;
    for (int i = 0; i < extra && p < end; i++) c = (c << 6) | (*p++ & 0x3f);
  }
  *pp = p;
  return c;
}

/* The contraction of code point c with the code point at p, setting *after
 * past that second code point; NULL when the pair is not a contraction. */
static const ScrCollEntry *scr_coll_contraction(uint32_t c, const unsigned char *p,
                                                const unsigned char *end,
                                                const unsigned char **after) {
  for (size_t k = 0; k < SCR_COLL_CONTRACTIONS; k++) {
    if (scr_coll_contractions[k].first != c || p == end) continue;
    const unsigned char *q = p;
    if (scr_coll_decode(&q, end) == scr_coll_contractions[k].second) {
      *after = q;
      return &scr_coll_contractions[k].entry;
    }
  }
  return NULL;
}

/* Whether code point c starts a contraction. */
static inline bool scr_coll_starts_contraction(uint32_t c) {
  if (c < SCR_COLL_BITS_LIMIT) return (scr_coll_starts_bits[c >> 6] >> (c & 63)) & 1;
  for (size_t k = 0; k < SCR_COLL_CONTRACTIONS; k++)
    if (scr_coll_contractions[k].first == c) return true;
  return false;
}

/* Elements of a UTF-8 string, marks in canonical order; false when a code
 * point is outside the table. */
static bool scr_coll_elements(const ScrStr *s, ScrCollBuf *b) {
  /* At most three elements per code point and one code point per byte:
   * reserve once, so the loop below needs no capacity checks. */
  if (s->len > SIZE_MAX / 3 / sizeof(ScrCollElem)) scr_oom();
  size_t need = 3 * s->len;
  if (need > b->cap) {
    b->e = malloc(need * sizeof *b->e);
    if (!b->e) scr_oom();
    b->cap = need;
  }
  const ScrCollAscii *ascii = scr_coll_ascii();
  ScrCollElem *e = b->e;
  size_t n = 0;
  const unsigned char *p = (const unsigned char *)s->data;
  const unsigned char *end = p + s->len;
  while (p < end) {
    uint32_t c = *p;
    if (c < 0x80 && scr_coll_ascii_plain[c]) {
      p++;
      e[n++] = (ScrCollElem){ascii[c].p, ascii[c].s, ascii[c].t, 0};
      continue;
    }
    c = scr_coll_decode(&p, end);
    const ScrCollEntry *entry = NULL;
    if (scr_coll_starts_contraction(c)) entry = scr_coll_contraction(c, p, end, &p);
    if (entry == NULL) entry = scr_coll_lookup(c);
    if (entry == NULL || entry->n == 255) {
      b->n = n;
      return false;
    }
    for (uint8_t i = 0; i < entry->n; i++) {
      ScrCollElem x = entry->e[i];
      size_t j = n++;
      /* Canonical reordering: a mark moves before marks of a higher class. */
      if (x.ccc != 0) {
        while (j > 0 && e[j - 1].ccc > x.ccc) {
          e[j] = e[j - 1];
          j--;
        }
      }
      e[j] = x;
    }
  }
  b->n = n;
  return true;
}

/* Lazy primary comparison for covered strings. Canonical reordering only
 * moves elements with a nonzero combining class; when none of those carries
 * a primary weight, the sequence of nonzero primaries is the table's
 * element order, so it can be read straight from the text and most pairs
 * are decided within their first characters. */
typedef struct {
  const unsigned char *p, *end;
  const ScrCollEntry *entry; /* the code point being read, or NULL */
  uint8_t next;              /* its next element */
} ScrCollCursor;

/* 0: every code point is covered and no mark carries a primary weight;
 * 1: covered, with such a mark; 2: a code point outside the table. */
static int scr_coll_scan(const ScrStr *s) {
  const unsigned char *p = (const unsigned char *)s->data, *end = p + s->len;
  int result = 0;
  while (p < end) {
    if (*p < 0x80 && scr_coll_ascii_plain[*p]) {
      p++;
      continue;
    }
    uint32_t c = scr_coll_decode(&p, end);
    if (c >= SCR_COLL_SCAN_LIMIT) {
      /* Above the class table: covered ones take the element lists. */
      const ScrCollEntry *entry = scr_coll_lookup(c);
      if (entry == NULL || entry->n == 255) return 2;
      result = 1;
      continue;
    }
    uint8_t klass = scr_coll_scan_class[c];
    if (klass == 2) return 2;
    result |= klass;
  }
  return result;
}

/* The next nonzero primary weight, or 0 at the end of the text. */
static unsigned scr_coll_next_primary(const ScrCollAscii *ascii, ScrCollCursor *c) {
  for (;;) {
    while (c->entry != NULL && c->next < c->entry->n) {
      unsigned p = c->entry->e[c->next++].p;
      if (p != 0) return p;
    }
    c->entry = NULL;
    if (c->p == c->end) return 0;
    if (*c->p < 0x80 && ascii[*c->p].ok) {
      unsigned p = ascii[*c->p++].p;
      if (p != 0) return p;
      continue;
    }
    c->entry = scr_coll_lookup(scr_coll_decode(&c->p, c->end));
    c->next = 0;
  }
}

/* The primary level of two strings scr_coll_scan answered 0 for. */
static int scr_coll_primary(const ScrCollAscii *ascii, const ScrStr *a, const ScrStr *b) {
  ScrCollCursor x = {(const unsigned char *)a->data, (const unsigned char *)a->data + a->len, NULL, 0};
  ScrCollCursor y = {(const unsigned char *)b->data, (const unsigned char *)b->data + b->len, NULL, 0};
  for (;;) {
    unsigned pa = scr_coll_next_primary(ascii, &x), pb = scr_coll_next_primary(ascii, &y);
    if (pa != pb) return pa == 0 ? -1 : pb == 0 ? 1 : pa < pb ? -1 : 1;
    if (pa == 0) return 0;
  }
}

static int scr_coll_level(const ScrCollBuf *a, const ScrCollBuf *b, int level) {
  size_t i = 0, j = 0;
  for (;;) {
    if (level == 0) {
      while (i < a->n && a->e[i].p == 0) i++;
      while (j < b->n && b->e[j].p == 0) j++;
    }
    if (i == a->n || j == b->n) return (i == a->n) == (j == b->n) ? 0 : i == a->n ? -1 : 1;
    unsigned wa = level == 0 ? a->e[i].p : level == 1 ? a->e[i].s : a->e[i].t;
    unsigned wb = level == 0 ? b->e[j].p : level == 1 ? b->e[j].s : b->e[j].t;
    if (wa != wb) return wa < wb ? -1 : 1;
    i++;
    j++;
  }
}

static inline bool scr_coll_ascii_byte(unsigned char c) {
  return c < 0x80 && ((scr_coll_ascii_mask[c >> 6] >> (c & 63)) & 1);
}

static bool scr_coll_ascii_tail(const unsigned char *p, size_t from, size_t len) {
  bool ok = true;
  for (size_t i = from; i < len; i++) ok &= scr_coll_ascii_byte(p[i]);
  return ok;
}

/* The primary level of two strings in one pass when every byte is a
 * covered ASCII byte with a nonzero primary: each byte is then exactly one
 * element, and the first differing primary decides. Validation continues
 * over the rest of both strings, because an uncovered byte anywhere moves
 * the whole comparison to code-point order. Returns -1 or 1, 0 when the
 * primaries are all equal, or 2 when a byte is not covered. */
static int scr_coll_ascii_primary_bytes(const ScrStr *a, const ScrStr *b) {
  const unsigned char *x = (const unsigned char *)a->data, *y = (const unsigned char *)b->data;
  size_t n = a->len, m = b->len, k = n < m ? n : m, i = 0;
  int r = 0;
  for (; i < k; i++) {
    unsigned char c = x[i], d = y[i];
    if (!scr_coll_ascii_byte(c) || !scr_coll_ascii_byte(d)) return 2;
    if (c != d) {
      unsigned pc = scr_coll_ascii_primaries[c], pd = scr_coll_ascii_primaries[d];
      if (pc != pd) {
        r = pc < pd ? -1 : 1;
        i++;
        break;
      }
    }
  }
  if (!scr_coll_ascii_tail(x, i, n) || !scr_coll_ascii_tail(y, i, m)) return 2;
  if (r == 0 && n != m) r = n < m ? -1 : 1;
  return r;
}

#define SCR_COLL_ONES UINT64_C(0x0101010101010101)
#define SCR_COLL_HIGHS (SCR_COLL_ONES * 0x80)

/* The 0 < n < 8 bytes at offset i of s's data in one word, the other lanes
 * zero. On little-endian targets: the eight bytes ending at the last of
 * them, shifted down; they start in the string's header when i + n < 8, so
 * the load stays inside the object. Elsewhere: fixed-size loads (a
 * variable-size memcpy is a library call). */
_Static_assert(offsetof(ScrStr, data) >= 8, "a short load may start in the header");
static inline uint64_t scr_coll_partial(const ScrStr *s, size_t i, size_t n) {
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
  uint64_t v;
  memcpy(&v, (const unsigned char *)s + offsetof(ScrStr, data) + i + n - 8, 8);
  return v >> (8 * (8 - n));
#else
  const unsigned char *p = (const unsigned char *)s->data + i;
  uint64_t w = 0;
  size_t o = 0;
  if (n & 4) {
    uint32_t v;
    memcpy(&v, p, 4);
    w = v;
    o = 4;
  }
  if (n & 2) {
    uint16_t v;
    memcpy(&v, p + o, 2);
    w |= (uint64_t)v << (8 * o);
    o += 2;
  }
  if (n & 1) w |= (uint64_t)p[o] << (8 * o);
  return w;
#endif
}

/* Up to eight bytes at offset i of s's data (n > 0 of them) as a word,
 * padded with spaces (a covered byte). */
static inline uint64_t scr_coll_word(const ScrStr *s, size_t i, size_t n) {
  uint64_t w;
  if (n >= 8) {
    memcpy(&w, s->data + i, 8);
    return w;
  }
  return scr_coll_partial(s, i, n) | (SCR_COLL_ONES * 0x20) << (8 * n);
}

/* Whether a byte of w is outside 0x20..0x7E: below 0x20, DEL, or non-ASCII. */
static inline bool scr_coll_word_unusual(uint64_t w) {
  return (((w - SCR_COLL_ONES * 0x20) & ~w) | (w + SCR_COLL_ONES) | w) & SCR_COLL_HIGHS;
}

/* 0 when s's bytes from offset `from` on are all 0x20..0x7E, 2 when one of
 * them is non-ASCII, 1 otherwise. */
static inline int scr_coll_printable_tail(const ScrStr *s, size_t from) {
  for (size_t i = from; i < s->len; i += 8) {
    uint64_t w = scr_coll_word(s, i, s->len - i);
    if (w & SCR_COLL_HIGHS) return 2;
    if (scr_coll_word_unusual(w)) return 1;
  }
  return 0;
}

/* scr_coll_ascii_primary_bytes eight bytes at a time when the covered ASCII
 * bytes are TAB..CR and 0x20..0x7E (scr_coll_ascii_printable): words of
 * printable bytes need no per-byte check, and equal words have equal
 * primaries. A non-ASCII byte anywhere answers 2 at once; a word with any
 * other byte outside 0x20..0x7E (a tab, say) sends the comparison to the
 * per-byte pass. */
static int scr_coll_ascii_primary(const ScrStr *a, const ScrStr *b) {
  if (!scr_coll_ascii_printable) return scr_coll_ascii_primary_bytes(a, b);
  const unsigned char *x = (const unsigned char *)a->data, *y = (const unsigned char *)b->data;
  size_t n = a->len, m = b->len, k = n < m ? n : m, i = 0;
  int r = 0;
  for (; i < k; i += 8) {
    uint64_t wx = scr_coll_word(a, i, k - i), wy = scr_coll_word(b, i, k - i);
    if ((wx | wy) & SCR_COLL_HIGHS) return 2; /* a non-ASCII byte */
    if (scr_coll_word_unusual(wx) || scr_coll_word_unusual(wy)) return scr_coll_ascii_primary_bytes(a, b);
    if (wx == wy) continue;
    size_t end = k - i < 8 ? k : i + 8;
    for (size_t j = i; j < end; j++) {
      unsigned pc = scr_coll_ascii_primaries[x[j]], pd = scr_coll_ascii_primaries[y[j]];
      if (pc != pd) {
        r = pc < pd ? -1 : 1;
        break;
      }
    }
    if (r != 0) {
      i = end;
      break;
    }
  }
  if (i > k) i = k;
  int tail = scr_coll_printable_tail(a, i) | scr_coll_printable_tail(b, i);
  if (tail != 0) return tail & 2 ? 2 : scr_coll_ascii_primary_bytes(a, b);
  if (r == 0 && n != m) r = n < m ? -1 : 1;
  return r;
}

static bool scr_coll_ascii_covered(const ScrCollAscii *table, const ScrStr *s) {
  const unsigned char *p = (const unsigned char *)s->data;
  bool ok = true;
  for (size_t i = 0; i < s->len; i++) ok &= p[i] < 0x80 && table[p[i]].ok;
  return ok;
}

/* scr_coll_level over the elements of two covered ASCII strings. */
static int scr_coll_ascii_level(const ScrCollAscii *table, const ScrStr *a, const ScrStr *b,
                                int level) {
  const unsigned char *x = (const unsigned char *)a->data, *y = (const unsigned char *)b->data;
  size_t n = a->len, m = b->len, i = 0, j = 0;
  for (;;) {
    if (level == 0) {
      while (i < n && table[x[i]].p == 0) i++;
      while (j < m && table[y[j]].p == 0) j++;
    }
    if (i == n || j == m) return (i == n) == (j == m) ? 0 : i == n ? -1 : 1;
    const ScrCollAscii *ea = &table[x[i]], *eb = &table[y[j]];
    unsigned wa = level == 0 ? ea->p : level == 1 ? ea->s : ea->t;
    unsigned wb = level == 0 ? eb->p : level == 1 ? eb->s : eb->t;
    if (wa != wb) return wa < wb ? -1 : 1;
    i++;
    j++;
  }
}

/* Whether two strings have the same bytes; strings of up to 16 bytes
 * compare as two words. */
static inline bool scr_coll_same_bytes(const ScrStr *a, const ScrStr *b) {
  size_t n = a->len;
  if (n != b->len) return false;
  const unsigned char *x = (const unsigned char *)a->data, *y = (const unsigned char *)b->data;
  if (n > 16) return memcmp(x, y, n) == 0;
  if (n < 8) return n == 0 || scr_coll_partial(a, 0, n) == scr_coll_partial(b, 0, n);
  uint64_t x0, y0, x1, y1;
  memcpy(&x0, x, 8);
  memcpy(&y0, y, 8);
  memcpy(&x1, x + n - 8, 8);
  memcpy(&y1, y + n - 8, 8);
  return x0 == y0 && x1 == y1;
}

/* Strings outside the ASCII paths: a scan finds uncovered characters
 * (code-point order) and characters that need element lists. Out of line,
 * so the ASCII paths do not set up the element buffers' stack frame. */
static __attribute__((noinline)) double scr_coll_compare_lists(const ScrCollAscii *table, ScrStr *a,
                                                               ScrStr *b) {
  if (scr_coll_same_bytes(a, b)) return 0;
  int scan_a = scr_coll_scan(a);
  if (scan_a == 2) return scr_str_cmp(a, b) < 0 ? -1 : 1; /* bytes differ (checked above) */
  int scan_b = scr_coll_scan(b);
  if (scan_b == 2) return scr_str_cmp(a, b) < 0 ? -1 : 1;
  if (scan_a == 0 && scan_b == 0) {
    int r = scr_coll_primary(table, a, b);
    if (r != 0) return (double)r;
  }
  /* The inline buffers are written before they are read: only the list
   * headers are initialized. */
  ScrCollBuf ea, eb;
  ea.n = eb.n = 0;
  ea.e = ea.inline_buf;
  ea.cap = sizeof ea.inline_buf / sizeof ea.inline_buf[0];
  eb.e = eb.inline_buf;
  eb.cap = sizeof eb.inline_buf / sizeof eb.inline_buf[0];
  int r = 0;
  if (scr_coll_elements(a, &ea) && scr_coll_elements(b, &eb)) {
    for (int level = 0; level < 3 && r == 0; level++) r = scr_coll_level(&ea, &eb, level);
  } else {
    int c = scr_str_cmp(a, b);
    r = c < 0 ? -1 : c > 0 ? 1 : 0;
  }
  if (ea.e != ea.inline_buf) free(ea.e);
  if (eb.e != eb.inline_buf) free(eb.e);
  return (double)r;
}

/* Equal bytes have equal elements at every level, so each path checks for
 * them before comparing secondary weights; the single-pass ASCII path does
 * so only after the primaries tie. */
double scr_str_locale_compare(ScrStr *a, ScrStr *b) {
  if (a == b) return 0;
  const ScrCollAscii *table = scr_coll_ascii();
  if (scr_coll_ascii_one_pass) {
    int r = scr_coll_ascii_primary(a, b);
    if (r != 2) {
      if (r == 0 && scr_coll_same_bytes(a, b)) return 0;
      for (int level = 1; level < 3 && r == 0; level++) r = scr_coll_ascii_level(table, a, b, level);
      return (double)r;
    }
  } else if (scr_coll_ascii_levels && scr_coll_ascii_covered(table, a) &&
             scr_coll_ascii_covered(table, b)) {
    if (scr_coll_same_bytes(a, b)) return 0;
    int r = 0;
    for (int level = 0; level < 3 && r == 0; level++) r = scr_coll_ascii_level(table, a, b, level);
    return (double)r;
  }
  return scr_coll_compare_lists(table, a, b);
}
