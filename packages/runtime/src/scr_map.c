/* ES Map<K, V> — the compact-dict design (see scr_runtime.h for the API
 * contract): a dense, insertion-ordered entries array plus an open-addressing
 * bucket table of entry indices. Deletions tombstone their entry (key and
 * value released immediately; the bucket slot keeps pointing at the dead
 * entry so probe chains stay intact); tombstones are compacted away when the
 * entries array grows — but never while an iteration is active (iter_depth),
 * which is what keeps the forEach desugar's plain indices stable under
 * arbitrary mutation from the callback.
 *
 * Cycle capability is per-map, decided at construction: val_trace non-NULL
 * means the value type carries a collector header, so records/objects stored
 * as values could point back at this map — the map allocates with the hidden
 * cycle header, its trace visits every live value, and the collector
 * teardown releases the complement (string keys) per the trace/teardown
 * contract in scr_runtime.h. Scalar-, string- and array-valued maps keep the
 * lean 1-word header and never touch the collector.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Live heap-map count for the RC audit lane (-DSCR_RC_AUDIT); same contract
 * as scr_str_live_count in scr_string.c. */
#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_maps = 0;
long scr_map_live_count(void) { return scr_live_maps; }
#endif

#define SCR_MAP_EMPTY SIZE_MAX

static void scr_map_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── key normalization + hashing (SameValueZero) ───────────────────────
 * -0 normalizes to +0 (JS Map stores the +0 key: [...m.keys()] shows 0
 * after set(-0)) and every NaN collapses to one canonical bit pattern, so
 * hashing the bit pattern IS SameValueZero hashing. */

static uint64_t scr_map_f64_bits(double k) {
  if (k != k) return UINT64_C(0x7ff8000000000000); /* canonical NaN */
  if (k == 0) k = 0; /* -0 -> +0 */
  uint64_t bits;
  memcpy(&bits, &k, sizeof bits);
  return bits;
}

static uint64_t scr_map_fnv1a(const unsigned char *bytes, size_t n) {
  uint64_t h = UINT64_C(0xcbf29ce484222325);
  for (size_t i = 0; i < n; i++) {
    h ^= bytes[i];
    h *= UINT64_C(0x100000001b3);
  }
  return h;
}

static uint64_t scr_map_hash_str(const ScrStr *k) {
  return scr_map_fnv1a((const unsigned char *)k->data, k->len);
}

/* ── slot packing (8-byte slots, like ScrArr) ──────────────────────────── */

static uint64_t scr_map_slot_from_f64(double v) {
  uint64_t s;
  memcpy(&s, &v, sizeof s);
  return s;
}

static double scr_map_slot_to_f64(uint64_t s) {
  double v;
  memcpy(&v, &s, sizeof v);
  return v;
}

static uint64_t scr_map_slot_from_ptr(void *p) { return (uint64_t)(uintptr_t)p; }

static void *scr_map_slot_to_ptr(uint64_t s) { return (void *)(uintptr_t)s; }

/* Stored keys are pre-normalized, so bit equality IS SameValueZero for f64
 * keys (probe keys normalize through the same function). */
static bool scr_map_key_eq(const ScrMap *m, uint64_t stored, uint64_t probe) {
  /* f64 keys are pre-normalized and REF keys are pointers, so bit equality
   * IS the honest compare for both (SameValueZero; reference identity). */
  if (m->key_kind != SCR_MAP_KEY_STR) return stored == probe;
  return scr_str_eq((ScrStr *)scr_map_slot_to_ptr(stored),
                     (ScrStr *)scr_map_slot_to_ptr(probe));
}

/* ── lookup ────────────────────────────────────────────────────────────
 * Returns the LIVE entry index holding the key, or SCR_MAP_EMPTY. Probes
 * skip tombstoned entries (their bucket slots keep chains intact). */
static size_t scr_map_find(const ScrMap *m, uint64_t hash, uint64_t key) {
  if (m->nbuckets == 0) return SCR_MAP_EMPTY;
  size_t mask = m->nbuckets - 1;
  for (size_t i = hash & mask;; i = (i + 1) & mask) {
    size_t b = m->buckets[i];
    if (b == SCR_MAP_EMPTY) return SCR_MAP_EMPTY;
    if (m->entries[b].live && scr_map_key_eq(m, m->entries[b].key, key)) return b;
  }
}

/* Rebuild the bucket table (size must be a power of two >= 2 * nentries):
 * only live entries are inserted, in dense order — dead markers vanish. */
static void scr_map_rebuild_buckets(ScrMap *m, size_t nbuckets) {
  size_t *buckets = malloc(nbuckets * sizeof *buckets);
  if (!buckets) scr_map_oom();
  for (size_t i = 0; i < nbuckets; i++) buckets[i] = SCR_MAP_EMPTY;
  free(m->buckets);
  m->buckets = buckets;
  m->nbuckets = nbuckets;
  size_t mask = nbuckets - 1;
  for (size_t e = 0; e < m->nentries; e++) {
    if (!m->entries[e].live) continue;
    uint64_t hash = m->key_kind != SCR_MAP_KEY_STR
                        ? scr_map_fnv1a((const unsigned char *)&m->entries[e].key, 8)
                        : scr_map_hash_str((ScrStr *)scr_map_slot_to_ptr(m->entries[e].key));
    size_t i = hash & mask;
    while (buckets[i] != SCR_MAP_EMPTY) i = (i + 1) & mask;
    buckets[i] = e;
  }
}

/* Drop tombstones, preserving insertion order. Only legal when no iteration
 * is active (the forEach desugar's indices would shift). */
static void scr_map_compact(ScrMap *m) {
  size_t w = 0;
  for (size_t r = 0; r < m->nentries; r++) {
    if (m->entries[r].live) m->entries[w++] = m->entries[r];
  }
  m->nentries = w;
  if (m->nbuckets > 0) scr_map_rebuild_buckets(m, m->nbuckets);
}

/* Make room to append one entry. Prefers compaction (tombstone-heavy maps
 * reuse their storage) and grows otherwise; while an iteration is active it
 * ONLY grows — indices must stay stable under callback mutation. */
static void scr_map_reserve_append(ScrMap *m) {
  if (m->nentries < m->ecap && m->nbuckets >= 2 * (m->nentries + 1)) return;
  if (m->iter_depth == 0 && m->nlive <= m->nentries / 2 && m->nentries > 0) {
    scr_map_compact(m);
  }
  if (m->nentries == m->ecap) {
    size_t cap = m->ecap ? m->ecap : 8;
    while (cap < m->nentries + 1) {
      if (cap > SIZE_MAX / 2 / sizeof(ScrMapEntry)) scr_map_oom();
      cap *= 2;
    }
    ScrMapEntry *entries = realloc(m->entries, cap * sizeof *entries);
    if (!entries) scr_map_oom();
    m->entries = entries;
    m->ecap = cap;
  }
  if (m->nbuckets < 2 * (m->nentries + 1)) {
    size_t nbuckets = m->nbuckets ? m->nbuckets : 16;
    while (nbuckets < 2 * (m->nentries + 1)) {
      if (nbuckets > SIZE_MAX / 2 / sizeof(size_t)) scr_map_oom();
      nbuckets *= 2;
    }
    scr_map_rebuild_buckets(m, nbuckets);
  }
}

/* ── entry release helpers ─────────────────────────────────────────────── */

static void scr_map_release_key(ScrMap *m, uint64_t key) {
  if (m->key_kind == SCR_MAP_KEY_STR) {
    scr_str_release((ScrStr *)scr_map_slot_to_ptr(key));
  } else if (m->key_kind == SCR_MAP_KEY_REF) {
    m->key_release(scr_map_slot_to_ptr(key));
  }
}

static void scr_map_release_val(ScrMap *m, uint64_t val) {
  if (m->val_kind == SCR_MAP_VAL_REF) m->val_release(scr_map_slot_to_ptr(val));
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

static void scr_map_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrMap *m = (ScrMap *)o;
  for (size_t e = 0; e < m->nentries; e++) {
    if (m->entries[e].live) visit(scr_map_slot_to_ptr(m->entries[e].val), ctx);
  }
}

/* Collector teardown: the trace visits every live VALUE (traced edges were
 * already accounted), so the complement released here is the keys. */
static void scr_map_gcfree(void *o) {
  ScrMap *m = (ScrMap *)o;
  for (size_t e = 0; e < m->nentries; e++) {
    if (m->entries[e].live) scr_map_release_key(m, m->entries[e].key);
  }
  free(m->entries);
  free(m->buckets);
#ifdef SCR_RC_AUDIT
  scr_live_maps--;
#endif
  scr_cyc_free(m);
}

ScrMap *scr_map_new(ScrMapKeyKind key_kind, ScrMapValKind val_kind,
                     void *(*val_retain)(void *), void (*val_release)(void *),
                     ScrTraceFn val_trace) {
  ScrMap *m;
  if (val_trace) {
    /* Cycle-capable values can point back: collector header + trace. */
    m = scr_cyc_alloc(sizeof *m, &scr_map_trace, &scr_map_gcfree);
  } else {
    m = calloc(1, sizeof *m);
    if (!m) scr_map_oom();
  }
  m->rc = 1;
  m->key_kind = key_kind;
  m->val_kind = val_kind;
  m->val_retain = val_retain;
  m->val_release = val_release;
  m->val_trace = val_trace;
#ifdef SCR_RC_AUDIT
  scr_live_maps++;
#endif
  return m;
}

ScrMap *scr_map_retain(ScrMap *m) {
  if (m->rc != SIZE_MAX) {
    m->rc++;
    if (m->val_trace) scr_cyc_mark_live(m);
  }
  return m;
}

void scr_map_release(ScrMap *m) {
  if (!m || m->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--m->rc == 0) {
    if (m->val_trace) scr_cyc_on_dead(m);
    for (size_t e = 0; e < m->nentries; e++) {
      if (!m->entries[e].live) continue;
      scr_map_release_key(m, m->entries[e].key);
      scr_map_release_val(m, m->entries[e].val);
    }
    free(m->entries);
    free(m->buckets);
#ifdef SCR_RC_AUDIT
    scr_live_maps--;
#endif
    if (m->val_trace) scr_cyc_free(m);
    else free(m);
  } else if (m->val_trace) {
    scr_cyc_on_release(m); /* possible cycle root; may collect — m is done */
  }
}

void *scr_map_retain_v(void *m) { return scr_map_retain((ScrMap *)m); }
void scr_map_release_v(void *m) { scr_map_release((ScrMap *)m); }
void scr_map_trace_v(void *m, ScrTraceVisit visit, void *ctx) {
  scr_map_trace(m, visit, ctx);
}

double scr_map_size(const ScrMap *m) { return (double)m->nlive; }

void scr_map_clear(ScrMap *m) {
  for (size_t e = 0; e < m->nentries; e++) {
    if (!m->entries[e].live) continue;
    m->entries[e].live = false;
    scr_map_release_key(m, m->entries[e].key);
    scr_map_release_val(m, m->entries[e].val);
  }
  m->nlive = 0;
  if (m->iter_depth == 0) {
    /* Full reset; an active iteration instead keeps the (now all-dead)
     * entries so its indices stay stable — entries added by the callback
     * after the clear append past them and ARE visited (Node-exact). */
    m->nentries = 0;
  }
  for (size_t i = 0; i < m->nbuckets; i++) m->buckets[i] = SCR_MAP_EMPTY;
}

/* ── has / delete ──────────────────────────────────────────────────────── */

bool scr_map_has_f64(const ScrMap *m, double key) {
  uint64_t k = scr_map_f64_bits(key);
  return scr_map_find(m, scr_map_fnv1a((const unsigned char *)&k, 8), k) != SCR_MAP_EMPTY;
}

bool scr_map_has_str(const ScrMap *m, const ScrStr *key) {
  uint64_t k = scr_map_slot_from_ptr((void *)key);
  return scr_map_find(m, scr_map_hash_str(key), k) != SCR_MAP_EMPTY;
}

static bool scr_map_delete_found(ScrMap *m, size_t e) {
  if (e == SCR_MAP_EMPTY) return false;
  m->entries[e].live = false; /* bucket slot stays: probe chains intact */
  m->nlive--;
  scr_map_release_key(m, m->entries[e].key);
  scr_map_release_val(m, m->entries[e].val);
  return true;
}

bool scr_map_delete_f64(ScrMap *m, double key) {
  uint64_t k = scr_map_f64_bits(key);
  return scr_map_delete_found(m, scr_map_find(m, scr_map_fnv1a((const unsigned char *)&k, 8), k));
}

bool scr_map_delete_str(ScrMap *m, const ScrStr *key) {
  uint64_t k = scr_map_slot_from_ptr((void *)key);
  return scr_map_delete_found(m, scr_map_find(m, scr_map_hash_str(key), k));
}

/* REF keys: identity hashing over the pointer bits (see the header's
 * SCR_MAP_KEY_REF note). Probes never retain; storage does. */
static size_t scr_map_find_ref(const ScrMap *m, const void *key) {
  uint64_t k = scr_map_slot_from_ptr((void *)key);
  return scr_map_find(m, scr_map_fnv1a((const unsigned char *)&k, 8), k);
}

bool scr_map_has_ref(const ScrMap *m, const void *key) {
  return scr_map_find_ref(m, key) != SCR_MAP_EMPTY;
}

bool scr_map_delete_ref(ScrMap *m, const void *key) {
  return scr_map_delete_found(m, scr_map_find_ref(m, key));
}

/* ── set ───────────────────────────────────────────────────────────────
 * Overwrite keeps the entry (insertion position preserved, stored key kept
 * — only the value is replaced-and-released). A new key appends: reserve
 * space FIRST (compaction/growth may rebuild buckets), then probe for the
 * insertion slot. */

static void scr_map_set(ScrMap *m, uint64_t hash, uint64_t key, uint64_t val) {
  size_t e = scr_map_find(m, hash, key);
  if (e != SCR_MAP_EMPTY) {
    uint64_t old = m->entries[e].val;
    m->entries[e].val = val; /* unlink before releasing (cycle collector) */
    scr_map_release_val(m, old);
    return;
  }
  scr_map_reserve_append(m);
  size_t idx = m->nentries++;
  m->entries[idx].key = key;
  m->entries[idx].val = val;
  m->entries[idx].live = true;
  m->nlive++;
  if (m->key_kind == SCR_MAP_KEY_STR) {
    scr_str_retain((ScrStr *)scr_map_slot_to_ptr(key)); /* key is borrowed */
  } else if (m->key_kind == SCR_MAP_KEY_REF) {
    m->key_retain(scr_map_slot_to_ptr(key)); /* key is borrowed */
  }
  size_t mask = m->nbuckets - 1;
  size_t i = hash & mask;
  while (m->buckets[i] != SCR_MAP_EMPTY) i = (i + 1) & mask;
  m->buckets[i] = idx;
}

static void scr_map_set_f64_key(ScrMap *m, double key, uint64_t val) {
  uint64_t k = scr_map_f64_bits(key); /* stores +0 for -0, canonical NaN */
  scr_map_set(m, scr_map_fnv1a((const unsigned char *)&k, 8), k, val);
}

static void scr_map_set_str_key(ScrMap *m, ScrStr *key, uint64_t val) {
  scr_map_set(m, scr_map_hash_str(key), scr_map_slot_from_ptr(key), val);
}

void scr_map_set_f64_f64(ScrMap *m, double key, double v) {
  scr_map_set_f64_key(m, key, scr_map_slot_from_f64(v));
}

void scr_map_set_f64_bool(ScrMap *m, double key, bool v) {
  scr_map_set_f64_key(m, key, (uint64_t)(v ? 1 : 0));
}

void scr_map_set_f64_ref(ScrMap *m, double key, void *v) {
  scr_map_set_f64_key(m, key, scr_map_slot_from_ptr(v));
}

void scr_map_set_str_f64(ScrMap *m, ScrStr *key, double v) {
  scr_map_set_str_key(m, key, scr_map_slot_from_f64(v));
}

void scr_map_set_str_bool(ScrMap *m, ScrStr *key, bool v) {
  scr_map_set_str_key(m, key, (uint64_t)(v ? 1 : 0));
}

void scr_map_set_str_ref(ScrMap *m, ScrStr *key, void *v) {
  scr_map_set_str_key(m, key, scr_map_slot_from_ptr(v));
}

void scr_map_set_ref_f64(ScrMap *m, void *key, double v) {
  uint64_t k = scr_map_slot_from_ptr(key);
  scr_map_set(m, scr_map_fnv1a((const unsigned char *)&k, 8), k, scr_map_slot_from_f64(v));
}

ScrMap *scr_set_new_ref(void *(*elem_retain)(void *), void (*elem_release)(void *)) {
  ScrMap *m = scr_map_new(SCR_MAP_KEY_REF, SCR_MAP_VAL_F64, NULL, NULL, NULL);
  m->key_retain = elem_retain;
  m->key_release = elem_release;
  return m;
}

/* ── get ───────────────────────────────────────────────────────────────── */

static size_t scr_map_find_f64(const ScrMap *m, double key) {
  uint64_t k = scr_map_f64_bits(key);
  return scr_map_find(m, scr_map_fnv1a((const unsigned char *)&k, 8), k);
}

static size_t scr_map_find_str(const ScrMap *m, const ScrStr *key) {
  return scr_map_find(m, scr_map_hash_str(key), scr_map_slot_from_ptr((void *)key));
}

bool scr_map_get_f64_f64(const ScrMap *m, double key, double *out) {
  size_t e = scr_map_find_f64(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(m->entries[e].val);
  return true;
}

bool scr_map_get_f64_bool(const ScrMap *m, double key, bool *out) {
  size_t e = scr_map_find_f64(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = m->entries[e].val != 0;
  return true;
}

void *scr_map_get_f64_ref(const ScrMap *m, double key) {
  size_t e = scr_map_find_f64(m, key);
  if (e == SCR_MAP_EMPTY) return NULL;
  return m->val_retain(scr_map_slot_to_ptr(m->entries[e].val)); /* +1 */
}

bool scr_map_get_str_f64(const ScrMap *m, const ScrStr *key, double *out) {
  size_t e = scr_map_find_str(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(m->entries[e].val);
  return true;
}

bool scr_map_get_str_bool(const ScrMap *m, const ScrStr *key, bool *out) {
  size_t e = scr_map_find_str(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = m->entries[e].val != 0;
  return true;
}

void *scr_map_get_str_ref(const ScrMap *m, const ScrStr *key) {
  size_t e = scr_map_find_str(m, key);
  if (e == SCR_MAP_EMPTY) return NULL;
  return m->val_retain(scr_map_slot_to_ptr(m->entries[e].val)); /* +1 */
}

/* ── iteration primitives (the forEach desugar) ────────────────────────── */

double scr_map_iter_count(const ScrMap *m) { return (double)m->nentries; }

bool scr_map_iter_live(const ScrMap *m, double i) {
  if (!(i >= 0) || i >= (double)m->nentries) return false;
  return m->entries[(size_t)i].live;
}

static const ScrMapEntry *scr_map_iter_at(const ScrMap *m, double i) {
  if (!(i >= 0) || i >= (double)m->nentries || !m->entries[(size_t)i].live) {
    scr_trap("scriptc: internal error: map iteration index out of range\n");
  }
  return &m->entries[(size_t)i];
}

double scr_map_iter_key_f64(const ScrMap *m, double i) {
  return scr_map_slot_to_f64(scr_map_iter_at(m, i)->key);
}

ScrStr *scr_map_iter_key_str(const ScrMap *m, double i) {
  return scr_str_retain((ScrStr *)scr_map_slot_to_ptr(scr_map_iter_at(m, i)->key));
}

void *scr_map_iter_key_ref(const ScrMap *m, double i) {
  return m->key_retain(scr_map_slot_to_ptr(scr_map_iter_at(m, i)->key)); /* +1 */
}

double scr_map_iter_val_f64(const ScrMap *m, double i) {
  return scr_map_slot_to_f64(scr_map_iter_at(m, i)->val);
}

bool scr_map_iter_val_bool(const ScrMap *m, double i) {
  return scr_map_iter_at(m, i)->val != 0;
}

void *scr_map_iter_val_ref(const ScrMap *m, double i) {
  return m->val_retain(scr_map_slot_to_ptr(scr_map_iter_at(m, i)->val)); /* +1 */
}

void scr_map_iter_enter(ScrMap *m) { m->iter_depth++; }

void scr_map_iter_exit(ScrMap *m) {
  if (m->iter_depth > 0) m->iter_depth--;
  /* A churny callback may have left many tombstones; with no iteration
   * active they are safe to drop now (bounds memory under forEach-heavy
   * add/delete workloads). */
  if (m->iter_depth == 0 && m->nlive <= m->nentries / 2 && m->nentries >= 16) {
    scr_map_compact(m);
  }
}

/* ── seeded Set construction ───────────────────────────────────────────── */

/* `new Set(values)`: add() every element of one borrowed T[] in order —
 * duplicates overwrite the unit value in place, so first insertion
 * position wins (SameValueZero, exactly JS). The map is a set (value kind
 * pinned to f64, every stored value 0); elements are the set's key kind —
 * f64 or string, matching the array's element kind. */
void scr_set_add_all(ScrMap *set, ScrArr *values) {
  size_t n = values->len;
  for (size_t i = 0; i < n; i++) {
    if (values->elem == SCR_ELEM_STR) {
      ScrStr *s = (ScrStr *)scr_arr_get_ref(values, (double)i); /* +1 */
      scr_map_set_str_f64(set, s, 0);                           /* borrows; retains stored copy */
      scr_str_release(s);
    } else if (set->key_kind == SCR_MAP_KEY_REF) {
      void *p = scr_arr_get_ref(values, (double)i); /* +1 */
      scr_map_set_ref_f64(set, p, 0);               /* borrows; retains stored copy */
      set->key_release(p);
    } else {
      scr_map_set_f64_f64(set, scr_arr_get_f64(values, (double)i), 0);
    }
  }
}

/* ── JS own-key ordering over the overflow map ─────────────────────────── */

/* Canonical array index test: "0".."4294967294" — digits only, no leading
 * zero (except "0" itself), value <= 2^32 - 2. JS orders these OWN keys
 * first, ascending numerically, before every other string key. */
static bool scr_map_key_array_index(const ScrStr *k, uint32_t *out) {
  size_t n = k->len;
  if (n == 0 || n > 10) return false;
  const char *s = k->data;
  if (s[0] == '0' && n > 1) return false;
  uint64_t v = 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] < '0' || s[i] > '9') return false;
    v = v * 10 + (uint64_t)(s[i] - '0');
  }
  if (v > UINT64_C(4294967294)) return false;
  *out = (uint32_t)v;
  return true;
}

/* The live STRING keys of `m` in JS OWN-KEY ORDER (Object.keys over the
 * index-signature overflow): integer-like keys (canonical array indices)
 * first in ascending numeric order, then the rest in insertion order.
 * Returns a fresh ScrStr* array (+1); the map is borrowed. Insertion sort
 * over the integer-like subset — overflow maps are small, and ties are
 * impossible (keys are unique). */
ScrArr *scr_map_keys_js_order(const ScrMap *m) {
  size_t n = m->nentries;
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, m->nlive);
  size_t nidx = 0;
  struct { uint32_t v; ScrStr *k; } *idx = NULL;
  for (size_t i = 0; i < n; i++) {
    if (!m->entries[i].live) continue;
    ScrStr *k = (ScrStr *)scr_map_slot_to_ptr(m->entries[i].key);
    uint32_t v;
    if (!scr_map_key_array_index(k, &v)) continue;
    if (nidx % 16 == 0) {
      idx = realloc(idx, (nidx + 16) * sizeof *idx);
      if (!idx) scr_map_oom();
    }
    size_t j = nidx++;
    while (j > 0 && idx[j - 1].v > v) {
      idx[j] = idx[j - 1];
      j--;
    }
    idx[j].v = v;
    idx[j].k = k;
  }
  for (size_t i = 0; i < nidx; i++) {
    scr_arr_push_ref(out, scr_str_retain(idx[i].k));
  }
  free(idx);
  for (size_t i = 0; i < n; i++) {
    if (!m->entries[i].live) continue;
    ScrStr *k = (ScrStr *)scr_map_slot_to_ptr(m->entries[i].key);
    uint32_t v;
    if (scr_map_key_array_index(k, &v)) continue;
    scr_arr_push_ref(out, scr_str_retain(k));
  }
  return out;
}
