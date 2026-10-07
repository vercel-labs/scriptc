/* ES Map<K, V> — the compact-dict design (see scr_runtime.h for the API
 * contract): a dense, insertion-ordered entries array plus an open-addressing
 * bucket table of entry indices. Deletions tombstone their entry (key and
 * value released immediately; the bucket slot keeps pointing at the dead
 * entry so probe chains stay intact); tombstones are compacted away when the
 * entries array grows — but never while an iteration is active (iter_depth),
 * which is what keeps the forEach desugar's plain indices stable under
 * arbitrary mutation from the callback.
 *
 * Cycle capability is per-map, decided at construction: either key_trace
 * or val_trace means that side carries a collector header and could point
 * back at this map. Such maps allocate with a hidden cycle header, trace
 * each live edge on the corresponding side, and release only the untraced
 * complement during collector teardown. Maps with neither trace adapter
 * keep the lean 1-word header and never touch the collector.
 */
#include "scr_runtime.h"
#include "scr_key.h"

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

static uint64_t scr_map_hash_str(const ScrStr *k) {
  return scr_key_hash(k->data, k->len);
}

/* Mix the complete normalized number or identity word. Float exponents
 * and aligned pointers need high bits to reach the low bucket-index bits. */
static uint64_t scr_map_hash_word(uint64_t value) {
  return scr_key_mix(value);
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

/* Union boxes are a compiler representation, not JavaScript objects. Keep
 * the box as the owned key, but hash and compare its reference payload. */
static uint64_t scr_map_identity(const ScrMap *m, uint64_t key) {
  if (m->key_kind == SCR_MAP_KEY_UNION_REF) {
    const ScrUnion *u = (const ScrUnion *)scr_map_slot_to_ptr(key);
    return scr_map_slot_from_ptr(scr_union_peek(u));
  }
  return key;
}

/* Checked-dynamic keys use the JavaScript value, not the temporary box.
 * Typed capsules preserve a native object's identity across repeated
 * crossings; numbers retain SameValueZero and strings compare by content. */
static uint64_t scr_map_hash_dyn(const ScrDyn *d) {
  uint64_t value;
  uint64_t kind = (uint64_t)d->kind;
  switch (d->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL: value = 0; break;
  case SCR_DYN_BOOL: value = d->v.b; break;
  case SCR_DYN_NUM: value = scr_map_f64_bits(d->v.num); break;
  case SCR_DYN_BIGINT: return scr_bigint_hash(d->v.bigint);
  case SCR_DYN_STR: return scr_map_hash_str(d->v.str);
  case SCR_DYN_SYMBOL: value = scr_map_slot_from_ptr(d->v.symbol.value); break;
  case SCR_DYN_FUNC: value = scr_map_slot_from_ptr(d->v.fn.class_obj ? (void *)d->v.fn.class_obj : (void *)d->v.fn.clo); break;
  case SCR_DYN_BYTES: value = scr_map_slot_from_ptr(d->v.bytes); break;
  case SCR_DYN_HANDLE: value = scr_map_slot_from_ptr(d->v.handle.ptr); break;
  case SCR_DYN_PROMISE: value = scr_map_slot_from_ptr(d->v.promise); break;
  case SCR_DYN_OBJ: value = scr_map_slot_from_ptr(d->v.obj.source_identity ? d->v.obj.source_identity : (void *)d); break;
  case SCR_DYN_TYPED_REF:
    value = scr_map_slot_from_ptr(d->v.typed_ref.ptr);
    // A materialized record and its capsule compare equal; their hashes
    // must also agree when a key crosses the boundary in either form.
    kind = SCR_DYN_OBJ;
    break;
  /* The optional island bridge exposes equality but no hash. A shared
   * bucket still preserves correctness without adding an engine dependency. */
  case SCR_DYN_JSVAL: value = 0; break;
  default: value = scr_map_slot_from_ptr((void *)d); break;
  }
  return scr_map_hash_word(value) ^ kind;
}

static bool scr_map_dyn_eq(const ScrDyn *a, const ScrDyn *b) {
  if (a->kind == SCR_DYN_NUM && b->kind == SCR_DYN_NUM) {
    return scr_map_f64_bits(a->v.num) == scr_map_f64_bits(b->v.num);
  }
  if (a->kind == SCR_DYN_TYPED_REF && b->kind == SCR_DYN_TYPED_REF) {
    return a->v.typed_ref.ptr == b->v.typed_ref.ptr;
  }
  return scr_dyn_strict_eq(a, b);
}

static uint64_t scr_map_hash_union(const ScrMap *m, const ScrUnion *key) {
  ScrMapKeyKind kind = (ScrMapKeyKind)m->union_keys[key->tag];
  switch (kind) {
  case SCR_MAP_KEY_STR: return scr_map_hash_str(scr_union_peek(key));
  case SCR_MAP_KEY_BIGINT: return scr_bigint_hash(scr_union_peek(key));
  case SCR_MAP_KEY_F64: return scr_map_hash_word(scr_map_f64_bits(scr_map_slot_to_f64(key->slot)));
  case SCR_MAP_KEY_NULL:
  case SCR_MAP_KEY_UNDEFINED: return scr_map_hash_word((uint64_t)kind);
  default: return scr_map_hash_word(key->slot);
  }
}

static bool scr_map_union_eq(const ScrMap *m, const ScrUnion *a, const ScrUnion *b) {
  ScrMapKeyKind kind = (ScrMapKeyKind)m->union_keys[a->tag];
  if (kind != (ScrMapKeyKind)m->union_keys[b->tag]) return false;
  switch (kind) {
  case SCR_MAP_KEY_STR: return scr_str_eq(scr_union_peek(a), scr_union_peek(b));
  case SCR_MAP_KEY_BIGINT: return scr_bigint_eq(scr_union_peek(a), scr_union_peek(b));
  case SCR_MAP_KEY_F64:
    return scr_map_f64_bits(scr_map_slot_to_f64(a->slot)) == scr_map_f64_bits(scr_map_slot_to_f64(b->slot));
  case SCR_MAP_KEY_NULL:
  case SCR_MAP_KEY_UNDEFINED: return true;
  default: return a->slot == b->slot;
  }
}

static uint64_t scr_map_hash_key(const ScrMap *m, uint64_t key) {
  if (m->key_kind == SCR_MAP_KEY_STR) return scr_map_hash_str((ScrStr *)scr_map_slot_to_ptr(key));
  if (m->key_kind == SCR_MAP_KEY_DYN) return scr_map_hash_dyn((ScrDyn *)scr_map_slot_to_ptr(key));
  if (m->key_kind == SCR_MAP_KEY_BIGINT) return scr_bigint_hash(scr_map_slot_to_ptr(key));
  if (m->key_kind == SCR_MAP_KEY_UNION_VALUE) return scr_map_hash_union(m, scr_map_slot_to_ptr(key));
  uint64_t identity = scr_map_identity(m, key);
  return scr_map_hash_word(identity);
}

/* Stored keys are pre-normalized, so bit equality IS SameValueZero for f64
 * keys (probe keys normalize through the same function). */
static bool scr_map_key_eq(const ScrMap *m, uint64_t stored, uint64_t probe) {
  if (m->key_kind == SCR_MAP_KEY_UNION_VALUE) {
    return scr_map_union_eq(m, scr_map_slot_to_ptr(stored), scr_map_slot_to_ptr(probe));
  }
  if (m->key_kind == SCR_MAP_KEY_BIGINT) {
    return scr_bigint_eq(scr_map_slot_to_ptr(stored), scr_map_slot_to_ptr(probe));
  }
  if (m->key_kind == SCR_MAP_KEY_DYN) {
    return scr_map_dyn_eq((ScrDyn *)scr_map_slot_to_ptr(stored), (ScrDyn *)scr_map_slot_to_ptr(probe));
  }
  /* f64 keys are pre-normalized and REF keys are pointers, so bit equality
   * IS the honest compare for both (SameValueZero; reference identity). */
  if (m->key_kind != SCR_MAP_KEY_STR) return scr_map_identity(m, stored) == scr_map_identity(m, probe);
  return scr_str_eq((ScrStr *)scr_map_slot_to_ptr(stored),
                     (ScrStr *)scr_map_slot_to_ptr(probe));
}

/* ── lookup ────────────────────────────────────────────────────────────
 * Returns the matching bucket, or the empty bucket where a new key belongs.
 * A zero entry hash marks a tombstone; cached hashes reject unrelated keys
 * before equality and survive table growth without hashing the keys again.
 * Remap zero to one so every live entry has a nonzero hash. */
typedef enum { SCR_MAP_LOOKUP_STR, SCR_MAP_LOOKUP_WORD, SCR_MAP_LOOKUP_GENERIC } ScrMapLookup;

/* Choose equality once per operation. Inlining the traversal with a constant
 * lookup kind keeps the ordinary string/word probe free of key-kind dispatch,
 * while boxed keys retain their complete value/identity semantics. */
static inline bool scr_map_lookup_eq(const ScrMap *m, uint64_t stored, uint64_t key,
                                     ScrMapLookup lookup) {
  if (lookup == SCR_MAP_LOOKUP_WORD) return stored == key;
  if (lookup == SCR_MAP_LOOKUP_STR) {
    const ScrStr *a = scr_map_slot_to_ptr(stored);
    const ScrStr *b = scr_map_slot_to_ptr(key);
    return a == b || (a->len == b->len && scr_key_equal(a->data, b->data, a->len));
  }
  return scr_map_key_eq(m, stored, key);
}

static inline __attribute__((always_inline)) size_t scr_map_probe_with(
    const ScrMap *m, uint64_t hash, uint64_t key, ScrMapLookup lookup) {
  if (m->nbuckets == 0) return SCR_MAP_EMPTY;
  size_t mask = m->nbuckets - 1;
  for (size_t i = hash & mask;; i = (i + 1) & mask) {
    size_t b = m->buckets[i];
    if (b == SCR_MAP_EMPTY) return i;
    if (m->entries[b].hash == hash && scr_map_lookup_eq(m, m->entries[b].key, key, lookup)) return i;
  }
}

#define SCR_MAP_LINEAR_LIMIT 4

/* Small collections keep only their ordered entries. Cached hashes make
 * the bounded scan cheap without allocating a separate bucket table. */
static inline __attribute__((always_inline)) size_t scr_map_find_with(
    const ScrMap *m, uint64_t hash, uint64_t key, ScrMapLookup lookup) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  hash = hash ? hash : 1;
  if (m->nbuckets == 0) {
    for (size_t e = 0; e < m->nentries; e++) {
      if (m->entries[e].hash == hash && scr_map_lookup_eq(m, m->entries[e].key, key, lookup)) return e;
    }
    return SCR_MAP_EMPTY;
  }
  size_t slot = scr_map_probe_with(m, hash, key, lookup);
  return slot == SCR_MAP_EMPTY ? SCR_MAP_EMPTY : m->buckets[slot];
}

static ScrMapLookup scr_map_lookup_kind(const ScrMap *m) {
  switch (m->key_kind) {
  case SCR_MAP_KEY_STR: return SCR_MAP_LOOKUP_STR;
  case SCR_MAP_KEY_F64:
  case SCR_MAP_KEY_BOOL:
  case SCR_MAP_KEY_REF:
  case SCR_MAP_KEY_NULL:
  case SCR_MAP_KEY_UNDEFINED: return SCR_MAP_LOOKUP_WORD;
  default: return SCR_MAP_LOOKUP_GENERIC;
  }
}

static size_t scr_map_probe(const ScrMap *m, uint64_t hash, uint64_t key) {
  switch (scr_map_lookup_kind(m)) {
  case SCR_MAP_LOOKUP_STR: return scr_map_probe_with(m, hash, key, SCR_MAP_LOOKUP_STR);
  case SCR_MAP_LOOKUP_WORD: return scr_map_probe_with(m, hash, key, SCR_MAP_LOOKUP_WORD);
  default: return scr_map_probe_with(m, hash, key, SCR_MAP_LOOKUP_GENERIC);
  }
}

static size_t scr_map_find(const ScrMap *m, uint64_t hash, uint64_t key) {
  switch (scr_map_lookup_kind(m)) {
  case SCR_MAP_LOOKUP_STR: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_STR);
  case SCR_MAP_LOOKUP_WORD: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_WORD);
  default: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_GENERIC);
  }
}

static size_t scr_map_find_f64(const ScrMap *m, double key) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  uint64_t k = scr_map_f64_bits(key);
  return scr_map_find_with(m, scr_map_hash_word(k), k, SCR_MAP_LOOKUP_WORD);
}

static size_t scr_map_find_str(const ScrMap *m, const ScrStr *key) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  return scr_map_find_with(m, scr_map_hash_str(key), scr_map_slot_from_ptr((void *)key),
                           SCR_MAP_LOOKUP_STR);
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
    uint64_t hash = m->entries[e].hash;
    if (!hash) continue;
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
    if (m->entries[r].hash) m->entries[w++] = m->entries[r];
  }
  m->nentries = w;
  if (m->nbuckets > 0) scr_map_rebuild_buckets(m, m->nbuckets);
}

/* Make room to append one entry. Prefers compaction (tombstone-heavy maps
 * reuse their storage) and grows otherwise; while an iteration is active it
 * ONLY grows — indices must stay stable under callback mutation. */
static void scr_map_reserve_append(ScrMap *m) {
  if (m->nentries < m->ecap &&
      ((m->nbuckets == 0 && m->nentries < SCR_MAP_LINEAR_LIMIT) ||
       m->nbuckets >= 2 * (m->nentries + 1))) return;
  if (m->iter_depth == 0 && m->nentries > 0 &&
      (m->nbuckets == 0 ? m->nlive < m->nentries : m->nlive <= m->nentries / 2)) {
    scr_map_compact(m);
  }
  if (m->nentries == m->ecap) {
    size_t cap = m->ecap ? m->ecap : 4;
    while (cap < m->nentries + 1) {
      if (cap > SIZE_MAX / 2 / sizeof(ScrMapEntry)) scr_map_oom();
      cap *= 2;
    }
    ScrMapEntry *entries = realloc(m->entries, cap * sizeof *entries);
    if (!entries) scr_map_oom();
    m->entries = entries;
    m->ecap = cap;
  }
  if (m->nbuckets == 0 && m->nentries < SCR_MAP_LINEAR_LIMIT) return;
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

static bool scr_map_ref_key(ScrMapKeyKind kind) {
  return kind == SCR_MAP_KEY_REF || kind == SCR_MAP_KEY_UNION_REF || kind == SCR_MAP_KEY_DYN ||
         kind == SCR_MAP_KEY_BIGINT || kind == SCR_MAP_KEY_UNION_VALUE;
}

static void scr_map_release_key(ScrMap *m, uint64_t key) {
  if (m->key_kind == SCR_MAP_KEY_STR) {
    scr_str_release((ScrStr *)scr_map_slot_to_ptr(key));
  } else if (scr_map_ref_key(m->key_kind)) {
    m->key_release(scr_map_slot_to_ptr(key));
  }
}

static void scr_map_release_val(ScrMap *m, uint64_t val) {
  if (m->val_kind == SCR_MAP_VAL_REF) m->val_release(scr_map_slot_to_ptr(val));
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

void scr_map_union_keys(ScrMap *map, const uint8_t *kinds) {
  map->union_keys = kinds;
}

static void scr_map_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrMap *m = (ScrMap *)o;
  for (size_t e = 0; e < m->nentries; e++) {
    if (!m->entries[e].hash) continue;
    if (m->key_trace) visit(scr_map_slot_to_ptr(m->entries[e].key), ctx);
    if (m->val_trace) visit(scr_map_slot_to_ptr(m->entries[e].val), ctx);
  }
}

/* The collector accounts for traced edges. Release only their complement:
 * an identity-key map may trace keys, values, or both independently. */
static void scr_map_gcfree(void *o) {
  ScrMap *m = (ScrMap *)o;
  scr_weak_dispose(m);
  for (size_t e = 0; e < m->nentries; e++) {
    if (!m->entries[e].hash) continue;
    if (!m->key_trace) scr_map_release_key(m, m->entries[e].key);
    if (!m->val_trace) scr_map_release_val(m, m->entries[e].val);
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
  return scr_map_new_typed(key_kind, val_kind, NULL, NULL, NULL, val_retain, val_release, val_trace);
}

ScrMap *scr_map_new_typed(ScrMapKeyKind key_kind, ScrMapValKind val_kind,
                         void *(*key_retain)(void *), void (*key_release)(void *),
                         ScrTraceFn key_trace,
                         void *(*val_retain)(void *), void (*val_release)(void *),
                         ScrTraceFn val_trace) {
  ScrMap *m;
  if (key_trace || val_trace) {
    /* Either side can point back: collector header + trace. */
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
  m->key_retain = key_retain;
  m->key_release = key_release;
  m->key_trace = key_trace;
#ifdef SCR_RC_AUDIT
  scr_live_maps++;
#endif
  return m;
}

ScrMap *scr_map_retain(ScrMap *m) {
  if (m->rc != SIZE_MAX) {
    m->rc++;
    if (m->key_trace || m->val_trace) scr_cyc_mark_live(m);
  }
  return m;
}

void scr_map_release(ScrMap *m) {
  if (!m || m->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--m->rc == 0) {
    scr_weak_dispose(m);
    if (m->key_trace || m->val_trace) scr_cyc_on_dead(m);
    for (size_t e = 0; e < m->nentries; e++) {
      if (!m->entries[e].hash) continue;
      scr_map_release_key(m, m->entries[e].key);
      scr_map_release_val(m, m->entries[e].val);
    }
    free(m->entries);
    free(m->buckets);
#ifdef SCR_RC_AUDIT
    scr_live_maps--;
#endif
    if (m->key_trace || m->val_trace) scr_cyc_free(m);
    else free(m);
  } else if (m->key_trace || m->val_trace) {
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
    if (!m->entries[e].hash) continue;
    m->entries[e].hash = 0;
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
  return scr_map_find_f64(m, key) != SCR_MAP_EMPTY;
}

bool scr_map_has_str(const ScrMap *m, const ScrStr *key) {
  return scr_map_find_str(m, key) != SCR_MAP_EMPTY;
}

static bool scr_map_delete_found(ScrMap *m, size_t e) {
  if (e == SCR_MAP_EMPTY) return false;
  m->entries[e].hash = 0; /* bucket slot stays: probe chains intact */
  m->nlive--;
  scr_map_release_key(m, m->entries[e].key);
  scr_map_release_val(m, m->entries[e].val);
  return true;
}

bool scr_map_delete_f64(ScrMap *m, double key) {
  return scr_map_delete_found(m, scr_map_find_f64(m, key));
}

bool scr_map_delete_str(ScrMap *m, const ScrStr *key) {
  return scr_map_delete_found(m, scr_map_find_str(m, key));
}

/* REF keys: identity hashing over the pointer bits (see the header's
 * SCR_MAP_KEY_REF note). Probes never retain; storage does. */
static size_t scr_map_find_ref(const ScrMap *m, const void *key) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  uint64_t k = scr_map_slot_from_ptr((void *)key);
  if (m->key_kind == SCR_MAP_KEY_REF) {
    return scr_map_find_with(m, scr_map_hash_word(k), k, SCR_MAP_LOOKUP_WORD);
  }
  return scr_map_find(m, scr_map_hash_key(m, k), k);
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
  hash = hash ? hash : 1;
  size_t slot = scr_map_probe(m, hash, key);
  size_t e = m->nbuckets == 0 ? scr_map_find(m, hash, key) : m->buckets[slot];
  if (e != SCR_MAP_EMPTY) {
    uint64_t old = m->entries[e].val;
    m->entries[e].val = val; /* unlink before releasing (cycle collector) */
    scr_map_release_val(m, old);
    return;
  }
  size_t old_entries = m->nentries, old_buckets = m->nbuckets;
  scr_map_reserve_append(m);
  /* Growth or compaction can move the insertion bucket. Otherwise keep the
   * empty slot from the first probe instead of walking the chain twice. */
  if (m->nbuckets && (m->nentries != old_entries || m->nbuckets != old_buckets)) {
    size_t mask = m->nbuckets - 1;
    slot = hash & mask;
    while (m->buckets[slot] != SCR_MAP_EMPTY) slot = (slot + 1) & mask;
  }
  size_t idx = m->nentries++;
  m->entries[idx].key = key;
  m->entries[idx].val = val;
  m->entries[idx].hash = hash;
  m->nlive++;
  if (m->key_kind == SCR_MAP_KEY_STR) {
    scr_str_retain((ScrStr *)scr_map_slot_to_ptr(key)); /* key is borrowed */
  } else if (m->key_kind == SCR_MAP_KEY_DYN) {
    const ScrDyn *d = (ScrDyn *)scr_map_slot_to_ptr(key);
    if (d->kind == SCR_DYN_NUM && d->v.num == 0) {
      /* Iteration returns +0 even when the inserted key was -0. Never
       * mutate the caller's shared box while normalizing a stored key. */
      m->entries[idx].key = scr_map_slot_from_ptr(scr_dyn_new_num(0));
    } else {
      m->key_retain(scr_map_slot_to_ptr(key));
    }
  } else if (m->key_kind == SCR_MAP_KEY_UNION_VALUE &&
             m->union_keys[((ScrUnion *)scr_map_slot_to_ptr(key))->tag] == SCR_MAP_KEY_F64 &&
             ((ScrUnion *)scr_map_slot_to_ptr(key))->slot == UINT64_C(0x8000000000000000)) {
    /* Normalize stored -0 without mutating the caller's immutable box. */
    ScrUnion *u = scr_map_slot_to_ptr(key);
    m->entries[idx].key = scr_map_slot_from_ptr(scr_union_new_f64(u->tag, 0));
  } else if (scr_map_ref_key(m->key_kind)) {
    m->key_retain(scr_map_slot_to_ptr(key)); /* key is borrowed */
  }
  if (m->nbuckets) m->buckets[slot] = idx;
}

static void scr_map_set_f64_key(ScrMap *m, double key, uint64_t val) {
  uint64_t k = scr_map_f64_bits(key); /* stores +0 for -0, canonical NaN */
  scr_map_set(m, scr_map_hash_word(k), k, val);
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
  scr_map_set(m, scr_map_hash_key(m, k), k, scr_map_slot_from_f64(v));
}

void scr_map_set_ref_bool(ScrMap *m, void *key, bool v) {
  uint64_t k = scr_map_slot_from_ptr(key);
  scr_map_set(m, scr_map_hash_key(m, k), k, (uint64_t)(v ? 1 : 0));
}

void scr_map_set_ref_ref(ScrMap *m, void *key, void *v) {
  uint64_t k = scr_map_slot_from_ptr(key);
  scr_map_set(m, scr_map_hash_key(m, k), k, scr_map_slot_from_ptr(v));
}

ScrMap *scr_set_new_ref(void *(*elem_retain)(void *), void (*elem_release)(void *)) {
  return scr_map_new_typed(SCR_MAP_KEY_REF, SCR_MAP_VAL_F64, elem_retain, elem_release, NULL, NULL, NULL, NULL);
}

/* ── get ───────────────────────────────────────────────────────────────── */

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

bool scr_map_get_ref_f64(const ScrMap *m, const void *key, double *out) {
  size_t e = scr_map_find_ref(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(m->entries[e].val);
  return true;
}

bool scr_map_get_ref_bool(const ScrMap *m, const void *key, bool *out) {
  size_t e = scr_map_find_ref(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = m->entries[e].val != 0;
  return true;
}

void *scr_map_get_ref_ref(const ScrMap *m, const void *key) {
  size_t e = scr_map_find_ref(m, key);
  if (e == SCR_MAP_EMPTY) return NULL;
  return m->val_retain(scr_map_slot_to_ptr(m->entries[e].val));
}

/* Boolean keys use unboxed 0/1 slots and the same probe path. */
static size_t scr_map_find_bool(const ScrMap *m, bool key) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  uint64_t slot = key ? 1 : 0;
  return scr_map_find_with(m, scr_map_hash_word(slot), slot, SCR_MAP_LOOKUP_WORD);
}

bool scr_map_has_bool(const ScrMap *m, bool key) {
  return scr_map_find_bool(m, key) != SCR_MAP_EMPTY;
}

bool scr_map_delete_bool(ScrMap *m, bool key) {
  return scr_map_delete_found(m, scr_map_find_bool(m, key));
}

void scr_map_set_bool_f64(ScrMap *m, bool key, double value) {
  scr_map_set(m, scr_map_hash_word(key ? 1 : 0), key ? 1 : 0, scr_map_slot_from_f64(value));
}

void scr_map_set_bool_bool(ScrMap *m, bool key, bool value) {
  scr_map_set(m, scr_map_hash_word(key ? 1 : 0), key ? 1 : 0, value ? 1 : 0);
}

void scr_map_set_bool_ref(ScrMap *m, bool key, void *value) {
  scr_map_set(m, scr_map_hash_word(key ? 1 : 0), key ? 1 : 0, scr_map_slot_from_ptr(value));
}

bool scr_map_get_bool_f64(const ScrMap *m, bool key, double *out) {
  size_t entry = scr_map_find_bool(m, key);
  if (entry == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(m->entries[entry].val);
  return true;
}

bool scr_map_get_bool_bool(const ScrMap *m, bool key, bool *out) {
  size_t entry = scr_map_find_bool(m, key);
  if (entry == SCR_MAP_EMPTY) return false;
  *out = m->entries[entry].val != 0;
  return true;
}

void *scr_map_get_bool_ref(const ScrMap *m, bool key) {
  size_t entry = scr_map_find_bool(m, key);
  if (entry == SCR_MAP_EMPTY) return NULL;
  return m->val_retain(scr_map_slot_to_ptr(m->entries[entry].val));
}

/* ── iteration primitives (the forEach desugar) ────────────────────────── */

double scr_map_iter_count(const ScrMap *m) { return (double)m->nentries; }

bool scr_map_iter_live(const ScrMap *m, double i) {
  if (!(i >= 0) || i >= (double)m->nentries) return false;
  return m->entries[(size_t)i].hash;
}

static const ScrMapEntry *scr_map_iter_at(const ScrMap *m, double i) {
  if (!(i >= 0) || i >= (double)m->nentries || !m->entries[(size_t)i].hash) {
    scr_trap("scriptc: internal error: map iteration index out of range\n");
  }
  return &m->entries[(size_t)i];
}

double scr_map_iter_key_f64(const ScrMap *m, double i) {
  return scr_map_slot_to_f64(scr_map_iter_at(m, i)->key);
}

bool scr_map_iter_key_bool(const ScrMap *m, double i) {
  return scr_map_iter_at(m, i)->key != 0;
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

void scr_map_dyn_attach(ScrMap *map, const ScrMapDynOps *ops) {
  map->dyn_ops = ops;
}

ScrDyn *scr_map_dyn_key(const ScrMap *map, double index) {
  uint64_t slot = scr_map_iter_at(map, index)->key;
  return map->dyn_ops ? map->dyn_ops->key_box(slot) : scr_dyn_retain(scr_map_slot_to_ptr(slot));
}

ScrDyn *scr_map_dyn_value(const ScrMap *map, double index) {
  uint64_t slot = scr_map_iter_at(map, index)->val;
  return map->dyn_ops ? map->dyn_ops->val_box(slot) : scr_dyn_retain(scr_map_slot_to_ptr(slot));
}

static size_t scr_map_dyn_find(ScrMap *map, const ScrDyn *key) {
  if (map->dyn_ops && !map->dyn_ops->key_matches(key)) return SCR_MAP_EMPTY;
  uint64_t slot = map->dyn_ops ? map->dyn_ops->key_unbox(key) : scr_map_slot_from_ptr(scr_dyn_retain((ScrDyn *)key));
  if (scr_exc_pending()) return SCR_MAP_EMPTY;
  if (map->key_kind == SCR_MAP_KEY_F64) slot = scr_map_f64_bits(scr_map_slot_to_f64(slot));
  size_t entry = scr_map_find(map, scr_map_hash_key(map, slot), slot);
  scr_map_release_key(map, slot);
  return entry;
}

ScrDyn *scr_map_dyn_get(ScrMap *map, const ScrDyn *key) {
  size_t entry = scr_map_dyn_find(map, key);
  if (scr_exc_pending()) return NULL;
  return entry == SCR_MAP_EMPTY ? scr_dyn_retain(scr_dyn_undefined()) : scr_map_dyn_value(map, (double)entry);
}

bool scr_map_dyn_has(ScrMap *map, const ScrDyn *key, bool remove) {
  size_t entry = scr_map_dyn_find(map, key);
  return remove ? scr_map_delete_found(map, entry) : entry != SCR_MAP_EMPTY;
}

void scr_map_dyn_set(ScrMap *map, const ScrDyn *key, const ScrDyn *value, bool set) {
  uint64_t key_slot = map->dyn_ops ? map->dyn_ops->key_unbox(key) : scr_map_slot_from_ptr(scr_dyn_retain((ScrDyn *)key));
  if (scr_exc_pending()) return;
  uint64_t value_slot = set ? 0 : map->dyn_ops ? map->dyn_ops->val_unbox(value) : scr_map_slot_from_ptr(scr_dyn_retain((ScrDyn *)value));
  if (scr_exc_pending()) { scr_map_release_key(map, key_slot); return; }
  if (map->key_kind == SCR_MAP_KEY_F64) key_slot = scr_map_f64_bits(scr_map_slot_to_f64(key_slot));
  scr_map_set(map, scr_map_hash_key(map, key_slot), key_slot, value_slot);
  scr_map_release_key(map, key_slot);
}

/* Copy only live entries. The source is borrowed, contains unique keys,
 * and runs no user code while traversed, so cached hashes remain valid. */
ScrMap *scr_map_clone(const ScrMap *source, bool keys_only) {
  ScrMap *out = scr_map_new_typed(source->key_kind, keys_only ? SCR_MAP_VAL_F64 : source->val_kind,
    source->key_retain, source->key_release, source->key_trace,
    keys_only ? NULL : source->val_retain, keys_only ? NULL : source->val_release,
    keys_only ? NULL : source->val_trace);
  out->union_keys = source->union_keys;
  size_t count = source->nlive;
  if (!count) return out;
  if (count > SIZE_MAX / sizeof(ScrMapEntry) || count > SIZE_MAX / 2 / sizeof(size_t)) scr_map_oom();
  out->entries = malloc(count * sizeof(ScrMapEntry));
  if (!out->entries) scr_map_oom();
  out->ecap = count;
  for (size_t i = 0; i < source->nentries; i++) {
    const ScrMapEntry *entry = &source->entries[i];
    if (!entry->hash) continue;
    ScrMapEntry *copy = &out->entries[out->nentries++];
    *copy = *entry;
    if (out->key_kind == SCR_MAP_KEY_STR) scr_str_retain(scr_map_slot_to_ptr(copy->key));
    else if (scr_map_ref_key(out->key_kind)) out->key_retain(scr_map_slot_to_ptr(copy->key));
    if (keys_only) copy->val = 0;
    else if (out->val_kind == SCR_MAP_VAL_REF) out->val_retain(scr_map_slot_to_ptr(copy->val));
  }
  out->nlive = count;
  if (count <= SCR_MAP_LINEAR_LIMIT) return out;
  size_t buckets = 16;
  while (buckets < 2 * count) {
    if (buckets > SIZE_MAX / 2 / sizeof(size_t)) scr_map_oom();
    buckets *= 2;
  }
  scr_map_rebuild_buckets(out, buckets);
  return out;
}

/* A generic view can be backed by typed slots. Its copy must accept new
 * JavaScript values independently of that backing's narrower adapters. */
ScrMap *scr_map_clone_dyn(const ScrMap *source, bool keys_only) {
  ScrMap *out = scr_map_new_typed(SCR_MAP_KEY_DYN, keys_only ? SCR_MAP_VAL_F64 : SCR_MAP_VAL_REF,
    scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v,
    keys_only ? NULL : scr_dyn_retain_v, keys_only ? NULL : scr_dyn_release_v,
    keys_only ? NULL : scr_dyn_trace_v);
  for (size_t i = 0; i < source->nentries; i++) {
    if (!source->entries[i].hash) continue;
    ScrDyn *key = scr_map_dyn_key(source, (double)i);
    uint64_t value = keys_only ? 0 : scr_map_slot_from_ptr(scr_map_dyn_value(source, (double)i));
    scr_map_set(out, scr_map_hash_dyn(key), scr_map_slot_from_ptr(key), value);
    scr_dyn_release(key);
  }
  return out;
}

void scr_map_values_into(ScrMap *set, const ScrMap *source, bool checked) {
  for (size_t i = 0; i < source->nentries; i++) {
    if (!source->entries[i].hash) continue;
    uint64_t value = checked ? scr_map_slot_from_ptr(scr_map_dyn_value(source, (double)i)) : source->entries[i].val;
    if (set->key_kind == SCR_MAP_KEY_F64) value = scr_map_f64_bits(scr_map_slot_to_f64(value));
    scr_map_set(set, scr_map_hash_key(set, value), value, 0);
    if (checked) scr_dyn_release(scr_map_slot_to_ptr(value));
  }
}

ScrArr *scr_set_to_arr_dyn(const ScrMap *map) {
  ScrArr *out = scr_arr_new_ref(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v, map->nlive);
  for (size_t i = 0; i < map->nentries; i++) {
    if (scr_map_iter_live(map, (double)i)) scr_arr_push_ref(out, scr_map_dyn_key(map, (double)i));
  }
  return out;
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
 * f64, string, or an identity reference matching the array's element kind. */
void scr_set_add_all(ScrMap *set, ScrArr *values) {
  size_t n = values->len;
  for (size_t i = 0; i < n; i++) {
    /* Packed values stay owned by the seed array throughout construction.
     * Avoid taking a temporary owner only to release it after insertion.
     * Sparse/missing positions retain the existing accessor semantics. */
    if (i < values->cap && values->present[i] == SCR_ARR_VALUE) {
      uint64_t key = values->data[i];
      if (set->key_kind == SCR_MAP_KEY_F64) key = scr_map_f64_bits(scr_map_slot_to_f64(key));
      scr_map_set(set, scr_map_hash_key(set, key), key, 0);
    } else if (values->elem == SCR_ELEM_STR) {
      ScrStr *s = (ScrStr *)scr_arr_get_ref(values, (double)i); /* +1 */
      scr_map_set_str_f64(set, s, 0);                           /* borrows; retains stored copy */
      scr_str_release(s);
    } else if (scr_map_ref_key(set->key_kind)) {
      void *p = scr_arr_get_ref(values, (double)i); /* +1 */
      scr_map_set_ref_f64(set, p, 0);               /* borrows; retains stored copy */
      set->key_release(p);
    } else if (set->key_kind == SCR_MAP_KEY_BOOL) {
      scr_map_set_bool_f64(set, scr_arr_get_bool(values, (double)i), 0);
    } else {
      scr_map_set_f64_f64(set, scr_arr_get_f64(values, (double)i), 0);
    }
  }
}

/* ── JS own-key ordering over the overflow map ─────────────────────────── */

/* Canonical array index test: "0".."4294967294" — digits only, no leading
 * zero (except "0" itself), value <= 2^32 - 2. JS orders these OWN keys
 * first, ascending numerically, before every other string key. */
static bool scr_map_key_array_index(const ScrStr *key, uint32_t *out) {
  return scr_key_array_index(key->data, key->len, out);
}

/* Enumerate numeric keys in ascending order, then other keys in insertion
 * order. Scratch entries refer to stable map indices, not copied strings. */
ScrArr *scr_map_keys_js_order(const ScrMap *m) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, m->nlive);
  if (m->nlive > SIZE_MAX / sizeof(ScrKeyIndex)) scr_map_oom();
  ScrKeyIndex *indices = NULL;
  size_t count = 0;
  for (size_t i = 0; i < m->nentries; i++) {
    if (!m->entries[i].hash) continue;
    ScrStr *key = scr_map_slot_to_ptr(m->entries[i].key);
    uint32_t index;
    if (!scr_map_key_array_index(key, &index)) continue;
    if (!indices) {
      indices = malloc(m->nlive * sizeof *indices);
      if (!indices) scr_map_oom();
    }
    indices[count++] = (ScrKeyIndex){index, i};
  }
  scr_key_index_sort(indices, count);
  for (size_t i = 0; i < count; i++) {
    ScrStr *key = scr_map_slot_to_ptr(m->entries[indices[i].entry].key);
    scr_arr_push_ref(out, scr_str_retain(key));
  }
  free(indices);
  for (size_t i = 0; i < m->nentries; i++) {
    if (!m->entries[i].hash) continue;
    ScrStr *key = scr_map_slot_to_ptr(m->entries[i].key);
    uint32_t index;
    if (!scr_map_key_array_index(key, &index)) scr_arr_push_ref(out, scr_str_retain(key));
  }
  return out;
}
