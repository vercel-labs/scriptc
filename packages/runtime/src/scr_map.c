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
/* A published map or set is immortal: it is never freed, so it leaves the count. */
void scr_map_live_forget(void) { scr_live_maps--; }
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

/* String keys hash to 32 bits so heap strings can cache the value in their
 * header (see SCR_STR_HASH_CACHE). The widened form keeps independent bits
 * for the bucket index (low half) and the compact fingerprint (top byte),
 * and is never zero, so it doubles as a live-entry marker. Spans and
 * strings share this function, so equal bytes always hash alike. */
static inline uint64_t scr_map_hash_widen(uint32_t h) {
  return ((uint64_t)h << 32) | h;
}

static inline uint32_t scr_map_hash_fold(const char *bytes, size_t length) {
  uint64_t h = scr_key_hash(bytes, length);
  uint32_t folded = (uint32_t)(h ^ (h >> 32));
  return folded ? folded : 1;
}

static inline uint64_t scr_map_hash_bytes(const char *bytes, size_t length) {
  return scr_map_hash_widen(scr_map_hash_fold(bytes, length));
}

/* Heap strings remember their hash: repeated lookups with one key object
 * (a stored neighbor, a parsed identifier, a get followed by a set) skip
 * the byte walk. Immortal strings may live in read-only memory and are
 * shared by every thread, so they are never written. */
static inline uint64_t scr_map_hash_str(const ScrStr *k) {
#if SCR_STR_HASH_CACHE
  uint32_t h = k->hash;
  if (__builtin_expect(h != 0, 1)) return scr_map_hash_widen(h);
  h = scr_map_hash_fold(k->data, k->len);
  /* A scratch slice is a writable stack copy (scr_str_is_scratch). */
  if (k->rc != SIZE_MAX || scr_str_is_scratch(k)) ((ScrStr *)k)->hash = h;
  return scr_map_hash_widen(h);
#else
  return scr_map_hash_bytes(k->data, k->len);
#endif
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
  case SCR_DYN_FUNC: value = scr_map_slot_from_ptr(d->v.fn.class_obj ? (void *)d->v.fn.class_obj : (void *)scr_closure_identity(d->v.fn.clo)); break;
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
  ScrMapKeyKind kind = (ScrMapKeyKind)m->ops->union_keys[key->tag];
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
  ScrMapKeyKind kind = (ScrMapKeyKind)m->ops->union_keys[a->tag];
  if (kind != (ScrMapKeyKind)m->ops->union_keys[b->tag]) return false;
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

/* ── entry layout ──────────────────────────────────────────────────────
 * A number-key map (SCR_MAP_KEY_F64) keeps 16-byte entries, the key and
 * the value: its hash is the key word's scr_key_mix, which is cheap to
 * recompute, and its stored keys are normalized (one NaN pattern, +0), so
 * a dead entry marks its key with a NaN pattern that no stored key has.
 * A SCR_MAP_VAL_CREF map (string keys, compact class values) keeps 16-byte
 * entries: the key, its 32-bit hash and the value as an address over 8.
 * Every other map keeps 24-byte entries with the cached hash, zero for a
 * dead entry. Every layout puts the key at byte 0; the 8-byte layouts put
 * the value at byte 8. */
static inline bool scr_map_num(const ScrMap *m) {
  return m->key_kind == SCR_MAP_KEY_F64;
}

static inline bool scr_map_cref(const ScrMap *m) {
  return __builtin_expect(m->val_kind == SCR_MAP_VAL_CREF, 0);
}

static inline size_t scr_map_entry_size(const ScrMap *m) {
  if (scr_map_num(m)) return sizeof(ScrMapNumEntry);
  if (scr_map_cref(m)) return sizeof(ScrMapCEntry);
  return sizeof(ScrMapEntry);
}

/* The entry at index e. A number-key entry has no hash field: read its key
 * and value only (scr_map_hash_at gives the hash); a SCR_MAP_VAL_CREF
 * entry's value is read with scr_map_val_at. */
static inline ScrMapEntry *scr_map_at(const ScrMap *m, size_t e) {
  return (ScrMapEntry *)((char *)m->entries + e * scr_map_entry_size(m));
}

static inline ScrMapCEntry *scr_map_c_at(const ScrMap *m, size_t e) {
  return (ScrMapCEntry *)m->entries + e;
}

static inline bool scr_map_live_at(const ScrMap *m, size_t e) {
  if (scr_map_num(m)) return ((const ScrMapNumEntry *)m->entries)[e].key != SCR_MAP_NUM_DEAD;
  if (scr_map_cref(m)) return scr_map_c_at(m, e)->hash != 0;
  return m->entries[e].hash != 0;
}

/* The entry's hash, nonzero when it is live and zero for a dead entry. */
static inline uint64_t scr_map_hash_at(const ScrMap *m, size_t e) {
  if (scr_map_num(m)) {
    uint64_t key = ((const ScrMapNumEntry *)m->entries)[e].key;
    if (key == SCR_MAP_NUM_DEAD) return 0;
    uint64_t hash = scr_map_hash_word(key);
    return hash ? hash : 1;
  }
  if (scr_map_cref(m)) {
    uint32_t h = scr_map_c_at(m, e)->hash;
    return h ? scr_map_hash_widen(h) : 0;
  }
  return m->entries[e].hash;
}

static inline void scr_map_kill_at(ScrMap *m, size_t e) {
  if (scr_map_num(m)) ((ScrMapNumEntry *)m->entries)[e].key = SCR_MAP_NUM_DEAD;
  else if (scr_map_cref(m)) scr_map_c_at(m, e)->hash = 0;
  else m->entries[e].hash = 0;
}

/* A compact value's 4-byte form and back (scr_cref_encode in scr_array.h). */
static inline uint32_t scr_map_cref_encode(uint64_t val) { return (uint32_t)(val >> 3); }
static inline uint64_t scr_map_cref_decode(uint32_t val) { return (uint64_t)val << 3; }

/* The value of entry e as an 8-byte slot, and its store. */
static inline uint64_t scr_map_val_at(const ScrMap *m, size_t e) {
  if (scr_map_num(m)) return ((const ScrMapNumEntry *)m->entries)[e].val;
  if (scr_map_cref(m)) return scr_map_cref_decode(scr_map_c_at(m, e)->val);
  return m->entries[e].val;
}

static inline void scr_map_val_put(ScrMap *m, size_t e, uint64_t val) {
  if (scr_map_num(m)) ((ScrMapNumEntry *)m->entries)[e].val = val;
  else if (scr_map_cref(m)) scr_map_c_at(m, e)->val = scr_map_cref_encode(val);
  else m->entries[e].val = val;
}

/* A reference value as a +1 result: compact values are never counted. */
static inline void *scr_map_val_retain(const ScrMap *m, uint64_t val) {
  if (scr_map_cref(m)) return scr_map_slot_to_ptr(val);
  return m->ops->val_retain(scr_map_slot_to_ptr(val));
}

/* A SCR_MAP_VAL_CREF map's keys are strings, whose hashes are widened
 * 32-bit values: the entry keeps the low half. */
static inline void scr_map_put_at(ScrMap *m, size_t e, uint64_t key, uint64_t val, uint64_t hash) {
  if (scr_map_num(m)) {
    ScrMapNumEntry *x = (ScrMapNumEntry *)m->entries + e;
    x->key = key;
    x->val = val;
    return;
  }
  if (scr_map_cref(m)) {
    ScrMapCEntry *x = scr_map_c_at(m, e);
    x->key = key;
    x->hash = (uint32_t)hash;
    x->val = scr_map_cref_encode(val);
    return;
  }
  ScrMapEntry *x = m->entries + e;
  x->key = key;
  x->val = val;
  x->hash = hash;
}

/* ── absent-key filter ─────────────────────────────────────────────────
 * Every live entry's hash sets two bits of m->filter, so a lookup whose
 * two bits are not both set is absent: most misses on small and medium
 * maps return from the header without loading the bucket table or the
 * entries. The bits come from hash bits 44..55, apart from the compact
 * fingerprint (top byte) and from the bucket index of every table small
 * enough for the filter to be selective. Deletions leave their bits (the
 * filter only has to cover the live keys); compaction recomputes it from
 * the survivors and clear empties it. */
static inline uint64_t scr_map_filter_bits(uint64_t hash) {
  return (UINT64_C(1) << (hash >> 44 & 63)) | (UINT64_C(1) << (hash >> 50 & 63));
}

/* ── lookup ────────────────────────────────────────────────────────────
 * Returns the matching bucket, or the empty bucket where a new key belongs.
 * A zero entry hash marks a tombstone; cached hashes reject unrelated keys
 * before equality and survive table growth without hashing the keys again.
 * Remap zero to one so every live entry has a nonzero hash. */
/* SCR_MAP_LOOKUP_NUM is a word compare on a number-key map, so the probe
 * reads 16-byte entries; SCR_MAP_LOOKUP_STR_C and SPAN_C are the string and
 * span probes of a SCR_MAP_VAL_CREF map, whose 16-byte entries keep a
 * 32-bit hash; every other lookup is on a map with 24-byte entries. Knowing
 * the layout from the lookup keeps the entry stride a constant in the
 * inlined probes. */
typedef enum {
  SCR_MAP_LOOKUP_STR,
  SCR_MAP_LOOKUP_SPAN,
  SCR_MAP_LOOKUP_WORD,
  SCR_MAP_LOOKUP_NUM,
  SCR_MAP_LOOKUP_GENERIC,
  SCR_MAP_LOOKUP_STR_C,
  SCR_MAP_LOOKUP_SPAN_C
} ScrMapLookup;

static inline bool scr_map_lookup_c(ScrMapLookup lookup) {
  return lookup == SCR_MAP_LOOKUP_STR_C || lookup == SCR_MAP_LOOKUP_SPAN_C;
}

typedef struct { const char *bytes; size_t length; } ScrMapSpan;

/* Choose equality once per operation. Inlining the traversal with a constant
 * lookup kind keeps the ordinary string/word probe free of key-kind dispatch,
 * while boxed keys retain their complete value/identity semantics. */
static inline bool scr_map_lookup_eq(const ScrMap *m, uint64_t stored, uint64_t key,
                                     ScrMapLookup lookup) {
  if (lookup == SCR_MAP_LOOKUP_WORD || lookup == SCR_MAP_LOOKUP_NUM) return stored == key;
  if (lookup == SCR_MAP_LOOKUP_SPAN || lookup == SCR_MAP_LOOKUP_SPAN_C) {
    const ScrStr *a = scr_map_slot_to_ptr(stored);
    const ScrMapSpan *b = scr_map_slot_to_ptr(key);
    return a->len == b->length && scr_key_equal(a->data, b->bytes, a->len);
  }
  if (lookup == SCR_MAP_LOOKUP_STR || lookup == SCR_MAP_LOOKUP_STR_C) {
    const ScrStr *a = scr_map_slot_to_ptr(stored);
    const ScrStr *b = scr_map_slot_to_ptr(key);
    return a == b || (a->len == b->len && scr_key_equal(a->data, b->data, a->len));
  }
  return scr_map_key_eq(m, stored, key);
}

/* The entry at index e of a map that `lookup` probes (see ScrMapLookup). */
static inline __attribute__((always_inline)) ScrMapEntry *scr_map_at_with(const ScrMap *m, size_t e,
                                                                          ScrMapLookup lookup) {
  if (lookup == SCR_MAP_LOOKUP_NUM) return (ScrMapEntry *)((ScrMapNumEntry *)m->entries + e);
  if (scr_map_lookup_c(lookup)) return (ScrMapEntry *)((ScrMapCEntry *)m->entries + e);
  return &m->entries[e];
}

/* Whether entry e holds `key`, whose hash is `hash`. A number-key map
 * compares the normalized key words alone; a dead entry's marker matches
 * no key. */
static inline __attribute__((always_inline)) bool scr_map_match_at(
    const ScrMap *m, size_t e, uint64_t hash, uint64_t key, ScrMapLookup lookup) {
  const ScrMapEntry *x = scr_map_at_with(m, e, lookup);
  if (lookup == SCR_MAP_LOOKUP_NUM) return x->key == key;
  if (scr_map_lookup_c(lookup))
    return ((const ScrMapCEntry *)x)->hash == (uint32_t)hash && scr_map_lookup_eq(m, x->key, key, lookup);
  return x->hash == hash && scr_map_lookup_eq(m, x->key, key, lookup);
}

/* Compact tables keep a hash fingerprint beside each 24-bit entry index.
 * Rejecting a collision here avoids loading an unrelated ordered entry.
 * Larger tables keep full-width indices; collection size remains limited
 * only by the allocator. Zero is empty in compact tables, so store index+1.
 * The LLVM backend's inline number-key probe (sc_map_entry_f64_hashed)
 * reads this encoding for tables of at most 1 << 24 buckets, hashes keys
 * as scr_map_find_f64 does, and calls scr_map_entry_f64 for wider tables;
 * only the runtime unit test builds a smaller bound. */
#ifndef SCR_MAP_COMPACT_BUCKETS
#define SCR_MAP_COMPACT_BUCKETS ((size_t)1 << 24)
#endif
_Static_assert(SCR_MAP_COMPACT_BUCKETS >= 16 &&
               SCR_MAP_COMPACT_BUCKETS <= ((size_t)1 << 24) &&
               (SCR_MAP_COMPACT_BUCKETS & (SCR_MAP_COMPACT_BUCKETS - 1)) == 0,
               "compact bucket capacity must leave room for every tagged index");
#define SCR_MAP_INDEX_MASK UINT32_C(0x00ffffff)

static bool scr_map_compact_buckets(size_t count) {
  return count <= SCR_MAP_COMPACT_BUCKETS;
}

static size_t scr_map_bucket(const ScrMap *m, size_t slot) {
  if (scr_map_compact_buckets(m->nbuckets)) {
    uint32_t index = ((const uint32_t *)m->buckets)[slot] & SCR_MAP_INDEX_MASK;
    return index ? (size_t)index - 1 : SCR_MAP_EMPTY;
  }
  return ((const size_t *)m->buckets)[slot];
}

static void scr_map_bucket_set(ScrMap *m, size_t slot, size_t entry, uint64_t hash) {
  if (scr_map_compact_buckets(m->nbuckets)) {
    ((uint32_t *)m->buckets)[slot] = (uint32_t)(entry + 1) | (uint32_t)(hash >> 32 & UINT32_C(0xff000000));
  } else {
    ((size_t *)m->buckets)[slot] = entry;
  }
}

static inline __attribute__((always_inline)) size_t scr_map_probe_with(
    const ScrMap *m, uint64_t hash, uint64_t key, ScrMapLookup lookup) {
  if (m->nbuckets == 0) return SCR_MAP_EMPTY;
  size_t mask = m->nbuckets - 1;
  if (scr_map_compact_buckets(m->nbuckets)) {
    const uint32_t *buckets = m->buckets;
    uint32_t tag = (uint32_t)(hash >> 32 & UINT32_C(0xff000000));
    for (size_t i = hash & mask;; i = (i + 1) & mask) {
      uint32_t bucket = buckets[i];
      if (!bucket) return i;
      if ((bucket & ~SCR_MAP_INDEX_MASK) != tag) continue;
      size_t b = (bucket & SCR_MAP_INDEX_MASK) - 1;
      if (scr_map_match_at(m, b, hash, key, lookup)) return i;
    }
  }
  const size_t *buckets = m->buckets;
  for (size_t i = hash & mask;; i = (i + 1) & mask) {
    size_t b = buckets[i];
    if (b == SCR_MAP_EMPTY) return i;
    if (scr_map_match_at(m, b, hash, key, lookup)) return i;
  }
}

/* The entry index for a key, or SCR_MAP_EMPTY: the probe of
 * scr_map_probe_with without returning to the bucket it stopped at. */
static inline __attribute__((always_inline)) size_t scr_map_probe_entry_with(
    const ScrMap *m, uint64_t hash, uint64_t key, ScrMapLookup lookup) {
  size_t mask = m->nbuckets - 1;
  if (scr_map_compact_buckets(m->nbuckets)) {
    const uint32_t *buckets = m->buckets;
    uint32_t tag = (uint32_t)(hash >> 32 & UINT32_C(0xff000000));
    for (size_t i = hash & mask;; i = (i + 1) & mask) {
      uint32_t bucket = buckets[i];
      if (!bucket) return SCR_MAP_EMPTY;
      if ((bucket & ~SCR_MAP_INDEX_MASK) != tag) continue;
      size_t b = (bucket & SCR_MAP_INDEX_MASK) - 1;
      if (scr_map_match_at(m, b, hash, key, lookup)) return b;
    }
  }
  const size_t *buckets = m->buckets;
  for (size_t i = hash & mask;; i = (i + 1) & mask) {
    size_t b = buckets[i];
    if (b == SCR_MAP_EMPTY) return SCR_MAP_EMPTY;
    if (scr_map_match_at(m, b, hash, key, lookup)) return b;
  }
}

/* Up to this many entries a map keeps no bucket table. */
#define SCR_MAP_LINEAR_LIMIT 8

/* Small collections keep only their ordered entries. Cached hashes make
 * the bounded scan cheap without allocating a separate bucket table. */
static inline __attribute__((always_inline)) size_t scr_map_find_with(
    const ScrMap *m, uint64_t hash, uint64_t key, ScrMapLookup lookup) {
  hash = hash ? hash : 1;
  /* Also rejects every key of an empty map (its filter is zero). */
  uint64_t bits = scr_map_filter_bits(hash);
  if ((m->filter & bits) != bits) return SCR_MAP_EMPTY;
  if (m->nbuckets == 0) {
    for (size_t e = 0; e < m->nentries; e++) {
      if (scr_map_match_at(m, e, hash, key, lookup)) return e;
    }
    return SCR_MAP_EMPTY;
  }
  return scr_map_probe_entry_with(m, hash, key, lookup);
}

static ScrMapLookup scr_map_lookup_kind(const ScrMap *m) {
  switch (m->key_kind) {
  case SCR_MAP_KEY_STR: return scr_map_cref(m) ? SCR_MAP_LOOKUP_STR_C : SCR_MAP_LOOKUP_STR;
  case SCR_MAP_KEY_F64: return SCR_MAP_LOOKUP_NUM;
  case SCR_MAP_KEY_BOOL:
  case SCR_MAP_KEY_REF:
  case SCR_MAP_KEY_NULL:
  case SCR_MAP_KEY_UNDEFINED: return SCR_MAP_LOOKUP_WORD;
  default: return SCR_MAP_LOOKUP_GENERIC;
  }
}

/* ── direct-indexed number keys ────────────────────────────────────────
 * Number-keyed maps whose keys are small non-negative integers (ids,
 * indices) index entries through dense[k] instead of hashing. The entries
 * array, tombstones and iteration are unchanged; only the index differs.
 * -0 lands on slot 0 (SameValueZero), and NaN, fractions, negatives and
 * keys beyond the table are absent by construction. A key that cannot be
 * stored densely converts the map to the bucket table; when that table
 * must grow, compact integer keys switch it back (scr_map_enter_dense). */

#define SCR_MAP_DENSE_MIN 16
/* Grow the table only while it stays within this factor of the live count
 * (32 bytes of index per entry at worst), so sparse keys fall back to the
 * bucket table instead of allocating for the largest key. */
#define SCR_MAP_DENSE_SPREAD 8
/* Small maps may cover keys up to this bound regardless of their size. */
#define SCR_MAP_DENSE_FLOOR 64

/* The table slot for a number key, or false when the key cannot have one. */
static inline bool scr_map_dense_slot(double k, size_t limit, size_t *out) {
  if (!(k >= 0) || !(k < (double)limit)) return false;
  size_t i = (size_t)k;
  if ((double)i != k) return false;
  *out = i;
  return true;
}

static inline size_t scr_map_find_dense(const ScrMap *m, double k) {
  size_t i;
  if (!scr_map_dense_slot(k, m->ndense, &i)) return SCR_MAP_EMPTY;
  uint32_t entry = m->dense[i];
  return entry ? (size_t)entry - 1 : SCR_MAP_EMPTY;
}

static size_t scr_map_find(const ScrMap *m, uint64_t hash, uint64_t key) {
  if (m->ndense) return scr_map_find_dense(m, scr_map_slot_to_f64(key));
  switch (scr_map_lookup_kind(m)) {
  case SCR_MAP_LOOKUP_STR: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_STR);
  case SCR_MAP_LOOKUP_STR_C: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_STR_C);
  case SCR_MAP_LOOKUP_WORD: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_WORD);
  case SCR_MAP_LOOKUP_NUM: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_NUM);
  default: return scr_map_find_with(m, hash, key, SCR_MAP_LOOKUP_GENERIC);
  }
}

static size_t scr_map_find_f64(const ScrMap *m, double key) {
  if (m->ndense) return scr_map_find_dense(m, key);
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  uint64_t k = scr_map_f64_bits(key);
  return scr_map_find_with(m, scr_map_hash_word(k), k, SCR_MAP_LOOKUP_NUM);
}

const ScrMapEntry *scr_map_entry_f64(const ScrMap *m, double key) {
  size_t e = scr_map_find_f64(m, key);
  return e == SCR_MAP_EMPTY ? NULL : scr_map_at(m, e);
}

/* The key's hash is usually cached, so even the small linear scan rejects
 * entries by hash before touching their bytes. */
/* The probes of a SCR_MAP_VAL_CREF map, out of line so that the inlined
 * probes of other maps keep their size. */
static __attribute__((noinline)) size_t scr_map_find_str_c(const ScrMap *m, const ScrStr *key) {
  return scr_map_find_with(m, scr_map_hash_str(key), scr_map_slot_from_ptr((void *)key),
                           SCR_MAP_LOOKUP_STR_C);
}

static __attribute__((noinline)) size_t scr_map_find_span_c(const ScrMap *m, const char *bytes,
                                                            size_t length) {
  ScrMapSpan key = { bytes, length };
  return scr_map_find_with(m, scr_map_hash_bytes(bytes, length), scr_map_slot_from_ptr(&key),
                           SCR_MAP_LOOKUP_SPAN_C);
}

static inline __attribute__((always_inline)) size_t scr_map_find_str(const ScrMap *m,
                                                                     const ScrStr *key) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  if (scr_map_cref(m)) return scr_map_find_str_c(m, key);
  return scr_map_find_with(m, scr_map_hash_str(key), scr_map_slot_from_ptr((void *)key),
                           SCR_MAP_LOOKUP_STR);
}

/* A transient input span follows the same hash, equality and ownership
 * rules as a string key without allocating or copying the probe. */
static size_t scr_map_find_span(const ScrMap *m, const char *bytes, size_t length) {
  if (m->nlive == 0) return SCR_MAP_EMPTY;
  if (scr_map_cref(m)) return scr_map_find_span_c(m, bytes, length);
  ScrMapSpan key = { bytes, length };
  return scr_map_find_with(m, scr_map_hash_bytes(bytes, length), scr_map_slot_from_ptr(&key),
                           SCR_MAP_LOOKUP_SPAN);
}

bool scr_map_get_span_f64(const ScrMap *m, const char *bytes, size_t length, double *out) {
  size_t e = scr_map_find_span(m, bytes, length);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(scr_map_val_at(m, e));
  return true;
}

bool scr_map_get_span_bool(const ScrMap *m, const char *bytes, size_t length, bool *out) {
  size_t e = scr_map_find_span(m, bytes, length);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_val_at(m, e) != 0;
  return true;
}

void *scr_map_get_span_ref(const ScrMap *m, const char *bytes, size_t length) {
  size_t e = scr_map_find_span(m, bytes, length);
  return e == SCR_MAP_EMPTY ? NULL : scr_map_val_retain(m, scr_map_val_at(m, e));
}

/* Rebuild the bucket table (size must be a power of two >= 2 * nentries):
 * only live entries are inserted, in dense order — dead markers vanish. */
static void scr_map_rebuild_buckets(ScrMap *m, size_t nbuckets) {
  bool compact = scr_map_compact_buckets(nbuckets);
  size_t bytes = nbuckets * (compact ? sizeof(uint32_t) : sizeof(size_t));
  void *buckets = scr_mem_alloc(bytes);
  if (!buckets) scr_map_oom();
  memset(buckets, compact ? 0 : 0xff, bytes);
  scr_mem_free(m->buckets);
  m->buckets = buckets;
  m->nbuckets = (uint32_t)nbuckets;
  size_t mask = nbuckets - 1;
  for (size_t e = 0; e < m->nentries; e++) {
    uint64_t hash = scr_map_hash_at(m, e);
    if (!hash) continue;
    size_t i = hash & mask;
    while (scr_map_bucket(m, i) != SCR_MAP_EMPTY) i = (i + 1) & mask;
    scr_map_bucket_set(m, i, e, hash);
  }
}

/* Point every live entry's dense slot at it (the table is zeroed first). */
static void scr_map_fill_dense(ScrMap *m) {
  memset(m->dense, 0, m->ndense * sizeof *m->dense);
  for (size_t e = 0; e < m->nentries; e++) {
    if (!scr_map_live_at(m, e)) continue;
    m->dense[(size_t)scr_map_slot_to_f64(scr_map_at(m, e)->key)] = (uint32_t)(e + 1);
  }
}

/* A table of at least SCR_MAP_DENSE_MIN slots covering index `top`, rounded
 * up to a multiple of SCR_MAP_DENSE_STEP. Lookups only compare a key with
 * ndense, so the length need not be a power of two. */
#define SCR_MAP_DENSE_STEP 64
static size_t scr_map_dense_size(size_t top) {
  if (top < SCR_MAP_DENSE_MIN) return SCR_MAP_DENSE_MIN;
  return (top / SCR_MAP_DENSE_STEP + 1) * SCR_MAP_DENSE_STEP;
}

/* The exclusive key bound a table may cover once it holds `live` entries.
 * Entry indices are stored as uint32_t + 1, and the table's length (a
 * multiple of SCR_MAP_DENSE_STEP covering every key) fits ScrMap.ndense. */
#define SCR_MAP_DENSE_MAX ((size_t)1 << 31)
static size_t scr_map_dense_limit(size_t live) {
  if (live > SIZE_MAX / SCR_MAP_DENSE_SPREAD) return SCR_MAP_DENSE_MAX;
  size_t limit = SCR_MAP_DENSE_SPREAD * live;
  if (limit < SCR_MAP_DENSE_FLOOR) limit = SCR_MAP_DENSE_FLOOR;
  return limit < SCR_MAP_DENSE_MAX ? limit : SCR_MAP_DENSE_MAX;
}

static void scr_map_dense_alloc(ScrMap *m, size_t n) {
  uint32_t *dense = scr_mem_realloc(m->dense, n * sizeof *dense);
  if (!dense) scr_map_oom();
  m->dense = dense;
  m->ndense = (uint32_t)n;
}

/* Called when a number-key map's linear scan or bucket table would grow to
 * take an absent key: index it directly when every live key and the
 * incoming key fit a compact table, keep hashing otherwise. One scan per
 * growth step keeps this amortized constant per insertion. */
static __attribute__((noinline)) void scr_map_enter_dense(ScrMap *m, double incoming) {
  size_t limit = scr_map_dense_limit(m->nlive + 1), top, i;
  if (m->nentries >= UINT32_MAX - 1 || !scr_map_dense_slot(incoming, limit, &top)) return;
  for (size_t e = 0; e < m->nentries; e++) {
    if (!scr_map_live_at(m, e)) continue;
    if (!scr_map_dense_slot(scr_map_slot_to_f64(scr_map_at(m, e)->key), limit, &i)) return;
    if (i > top) top = i;
  }
  scr_mem_free(m->buckets);
  m->buckets = NULL;
  m->nbuckets = 0;
  scr_map_dense_alloc(m, scr_map_dense_size(top));
  scr_map_fill_dense(m);
}

/* Extend the table to cover a new integral key while it stays compact. It
 * grows by at least a quarter (within the key bound), so keys that arrive in
 * increasing order reallocate a logarithmic number of times. */
static __attribute__((noinline)) bool scr_map_grow_dense(ScrMap *m, double k, size_t *out) {
  size_t i, limit = scr_map_dense_limit(m->nlive + 1);
  if (!scr_map_dense_slot(k, limit, &i)) return false;
  size_t old = m->ndense, step = old + old / 4;
  size_t n = scr_map_dense_size((step < limit ? step : limit) - 1);
  if (n <= i) n = scr_map_dense_size(i);
  scr_map_dense_alloc(m, n);
  memset(m->dense + old, 0, (n - old) * sizeof *m->dense);
  *out = i;
  return true;
}

/* Switch to the bucket table; cached entry hashes are already complete. */
static __attribute__((noinline)) void scr_map_leave_dense(ScrMap *m) {
  scr_mem_free(m->dense);
  m->dense = NULL;
  m->ndense = 0;
  if (m->nentries < SCR_MAP_LINEAR_LIMIT) return;
  size_t nbuckets = 16;
  while (nbuckets < 2 * (m->nentries + 1)) {
    if (nbuckets > SIZE_MAX / 2 / sizeof(size_t)) scr_map_oom();
    nbuckets *= 2;
  }
  scr_map_rebuild_buckets(m, nbuckets);
}

/* Drop tombstones, preserving insertion order. Only legal when no iteration
 * is active (the forEach desugar's indices would shift).
 *
 * Index tables are sized by the most entries a map has held, so a map that
 * shrank keeps rebuilding (and clearing) a table sized for its peak. A
 * bucket table more than eight times what the survivors need shrinks to
 * twice that, leaving room to double before it grows again. With `reindex`
 * the direct index also follows the surviving keys: it shrinks to cover the
 * largest one, and keys that became sparse move back to hashing (at twice
 * the spread that admits them, so churn cannot flip modes). The append path
 * passes false: it holds a slot of the current direct index. */
static void scr_map_compact(ScrMap *m, bool reindex) {
  size_t w = 0, top = 0;
  uint64_t filter = 0;
  bool dense = m->ndense != 0;
  for (size_t r = 0; r < m->nentries; r++) {
    if (!scr_map_live_at(m, r)) continue;
    if (dense) {
      size_t k = (size_t)scr_map_slot_to_f64(scr_map_at(m, r)->key);
      if (k > top) top = k;
    }
    filter |= scr_map_filter_bits(scr_map_hash_at(m, r));
    if (w != r) {
      /* A constant size per layout keeps the copy inline. */
      if (scr_map_num(m)) memcpy(scr_map_at(m, w), scr_map_at(m, r), sizeof(ScrMapNumEntry));
      else if (scr_map_cref(m)) memcpy(scr_map_at(m, w), scr_map_at(m, r), sizeof(ScrMapCEntry));
      else memcpy(scr_map_at(m, w), scr_map_at(m, r), sizeof(ScrMapEntry));
    }
    w++;
  }
  m->nentries = (uint32_t)w;
  m->filter = filter;
  m->head = 0;
  if (m->nbuckets > 0) {
    size_t want = 16;
    while (want < 2 * (w + 1)) want *= 2;
    scr_map_rebuild_buckets(m, m->nbuckets / 8 > want ? 2 * want : m->nbuckets);
    return;
  }
  if (!dense) return;
  if (reindex) {
    if (w == 0) {
      scr_mem_free(m->dense);
      m->dense = NULL;
      m->ndense = 0;
      return;
    }
    size_t limit = scr_map_dense_limit(w);
    if (top / 2 >= limit) {
      scr_map_leave_dense(m);
      return;
    }
    size_t need = scr_map_dense_size(top);
    if (need < m->ndense) scr_map_dense_alloc(m, need);
  }
  scr_map_fill_dense(m);
}

/* The most entries a map holds, tombstones included: its 32-bit counts and
 * its bucket count (a power of two at least twice the entries) stay in
 * range. */
#define SCR_MAP_MAX_ENTRIES ((size_t)1 << 30)

/* The entry capacity after `cap`: 1, 2, 3, 4, 6, 8, 12, 16, then doubling.
 * Most maps hold one to four entries, so a small map keeps at most a third
 * of its slots unused, and appends stay amortized constant. */
static size_t scr_map_next_ecap(size_t cap) {
  if (cap < 4) return cap + 1;
  if (cap < 16) return cap < 8 ? cap + 2 : cap + 4;
  return cap * 2;
}

static void scr_map_grow_entries(ScrMap *m) {
  size_t cap = scr_map_next_ecap(m->ecap);
  while (cap < m->nentries + 1) cap = scr_map_next_ecap(cap);
  if (cap > SCR_MAP_MAX_ENTRIES) scr_map_oom();
  ScrMapEntry *entries = scr_mem_realloc(m->entries, cap * scr_map_entry_size(m));
  if (!entries) scr_map_oom();
  m->entries = entries;
  m->ecap = (uint32_t)cap;
}

/* Make room to append one entry. Prefers compaction (tombstone-heavy maps
 * reuse their storage) and grows otherwise; while an iteration is active it
 * ONLY grows — indices must stay stable under callback mutation. */
static void scr_map_reserve_append(ScrMap *m) {
  if (m->ndense) {
    /* Directly indexed: the table is sized by keys, not entry count. */
    if (m->nentries < m->ecap) return;
    if (m->iter_depth == 0 && m->nentries > 0 && m->nlive <= m->nentries / 2) scr_map_compact(m, false);
    if (m->nentries == m->ecap) scr_map_grow_entries(m);
    return;
  }
  if (m->nentries < m->ecap &&
      ((m->nbuckets == 0 && m->nentries < SCR_MAP_LINEAR_LIMIT) ||
       m->nbuckets >= 2 * (m->nentries + 1))) return;
  if (m->iter_depth == 0 && m->nentries > 0 &&
      (m->nbuckets == 0 ? m->nlive < m->nentries : m->nlive <= m->nentries / 2)) {
    scr_map_compact(m, false);
  }
  if (m->nentries == m->ecap) scr_map_grow_entries(m);
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
    m->ops->key_release(scr_map_slot_to_ptr(key));
  }
}

static void scr_map_release_val(ScrMap *m, uint64_t val) {
  if (m->val_kind == SCR_MAP_VAL_REF) m->ops->val_release(scr_map_slot_to_ptr(val));
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

static void scr_map_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrMap *m = (ScrMap *)o;
  bool keys = m->traced & SCR_MAP_TRACED_KEY, vals = m->traced & SCR_MAP_TRACED_VAL;
  for (size_t e = 0; e < m->nentries; e++) {
    if (!scr_map_live_at(m, e)) continue;
    if (keys) visit(scr_map_slot_to_ptr(scr_map_at(m, e)->key), ctx);
    if (vals) visit(scr_map_slot_to_ptr(scr_map_val_at(m, e)), ctx);
  }
}

/* The collector accounts for traced edges. Release only their complement:
 * an identity-key map may trace keys, values, or both independently. */
static void scr_map_gcfree(void *o) {
  ScrMap *m = (ScrMap *)o;
  bool keys = m->traced & SCR_MAP_TRACED_KEY, vals = m->traced & SCR_MAP_TRACED_VAL;
  scr_weak_dispose_inline(m);
  for (size_t e = 0; e < m->nentries; e++) {
    if (!scr_map_live_at(m, e)) continue;
    if (!keys) scr_map_release_key(m, scr_map_at(m, e)->key);
    if (!vals) scr_map_release_val(m, scr_map_val_at(m, e));
  }
  scr_mem_free(m->entries);
  scr_mem_free(m->buckets);
  scr_mem_free(m->dense);
#ifdef SCR_RC_AUDIT
  scr_live_maps--;
#endif
  scr_cyc_free(m);
}

/* Map construction inlines into its callers; keeping the header allocation
 * out of line keeps those call sites as small as the libc call they had. */
static __attribute__((noinline)) ScrMap *scr_map_alloc_plain(void) {
  return scr_mem_calloc(sizeof(ScrMap));
}

static const ScrMapOps scr_map_no_ops = {0};

ScrMap *scr_map_new(ScrMapKeyKind key_kind, ScrMapValKind val_kind, const ScrMapOps *ops) {
  if (!ops) ops = &scr_map_no_ops;
  unsigned traced = (ops->key_trace ? SCR_MAP_TRACED_KEY : 0) | (ops->val_trace ? SCR_MAP_TRACED_VAL : 0);
  ScrMap *m;
  if (traced) {
    /* Either side can point back: collector header + trace. */
    static ScrCycType cyc_type = { &scr_map_trace, &scr_map_gcfree, SCR_CYC_KIND_MAP };
    m = scr_cyc_alloc(sizeof *m, &cyc_type);
  } else {
    m = scr_map_alloc_plain();
    if (!m) scr_map_oom();
  }
  m->rc = 1;
  m->key_kind = (uint8_t)key_kind;
  m->val_kind = (uint8_t)val_kind;
  m->traced = (uint8_t)traced;
  m->ops = ops;
#ifdef SCR_RC_AUDIT
  scr_live_maps++;
#endif
  return m;
}

ScrMap *scr_map_retain(ScrMap *m) {
  if (m->rc != SIZE_MAX) {
    m->rc++;
  }
  return m;
}

static void scr_map_destroy(void *object) {
  ScrMap *m = object;
  scr_weak_dispose_inline(m);
  /* Number and boolean keys, and values other than references, own
   * nothing: a map of only those releases no entries. */
  bool keys = m->key_kind == SCR_MAP_KEY_STR || scr_map_ref_key(m->key_kind);
  if (keys || m->val_kind == SCR_MAP_VAL_REF) {
    for (size_t e = 0; e < m->nentries; e++) {
      if (!scr_map_live_at(m, e)) continue;
      scr_map_release_key(m, scr_map_at(m, e)->key);
      scr_map_release_val(m, scr_map_val_at(m, e));
    }
  }
  scr_mem_free(m->entries);
  scr_mem_free(m->buckets);
  scr_mem_free(m->dense);
#ifdef SCR_RC_AUDIT
  scr_live_maps--;
#endif
  if (m->traced) scr_cyc_free(m);
  else scr_mem_free(m);
}

void scr_map_release(ScrMap *m) {
  if (!m || m->rc == SIZE_MAX) return; /* NULL: an uninitialized `let` local */
  if (--m->rc == 0) {
    if (m->traced) scr_cyc_dead(m);
    scr_rc_destroy(m, scr_map_destroy);
  } else if (m->traced) {
    scr_cyc_released(m); /* possible cycle root; may collect — m is done */
  }
}

void *scr_map_retain_v(void *m) { return scr_map_retain((ScrMap *)m); }
void scr_map_release_v(void *m) { scr_map_release((ScrMap *)m); }
void scr_map_trace_v(void *m, ScrTraceVisit visit, void *ctx) {
  scr_map_trace(m, visit, ctx);
}

double scr_map_size(const ScrMap *m) { return (double)m->nlive; }

/* Storage clear() keeps regardless of how many entries it removed. */
#define SCR_MAP_CLEAR_KEEP 256

/* clear() costs time proportional to the entries it walks (live entries
 * and tombstones appended since the last reset), never to the peak size of
 * the index tables:
 *  - the direct index is zero exactly at the absent keys (deletes clear
 *    their slots), so only the live entries' slots are reset;
 *  - the bucket table is reset only while it is proportional to the
 *    entries that pointed into it;
 *  - storage far larger than the entries just removed is freed, returning
 *    the map to its initial empty state the way V8 reallocates a cleared
 *    table. Regrowth is amortized against the insertions that need it.
 * A map without entries has empty tables already: clearing it does no
 * work and keeps its storage for the next fill. */
void scr_map_prevent_extensions(ScrMap *m) {
  if (m->rc != SIZE_MAX) m->flags |= SCR_MAP_NOT_EXTENSIBLE;
}

bool scr_map_is_extensible(const ScrMap *m) { return (m->flags & SCR_MAP_NOT_EXTENSIBLE) == 0; }

void scr_map_clear(ScrMap *m) {
  size_t walked = m->nentries;
  if (walked == 0) return;
  uint32_t *dense = m->ndense ? m->dense : NULL;
  for (size_t e = 0; e < walked; e++) {
    if (!scr_map_live_at(m, e)) continue;
    uint64_t key = scr_map_at(m, e)->key, val = scr_map_val_at(m, e);
    scr_map_kill_at(m, e);
    if (dense) dense[(size_t)scr_map_slot_to_f64(key)] = 0;
    scr_map_release_key(m, key);
    scr_map_release_val(m, val);
  }
  m->nlive = 0;
  m->filter = 0;
  m->head = (uint32_t)walked;
  if (m->iter_depth == 0) {
    /* Full reset; an active iteration instead keeps the (now all-dead)
     * entries so its indices stay stable — entries added by the callback
     * after the clear append past them and ARE visited (Node-exact). */
    m->nentries = 0;
    m->head = 0;
    if (m->ecap > SCR_MAP_CLEAR_KEEP && m->ecap / 8 > walked) {
      scr_mem_free(m->entries);
      m->entries = NULL;
      m->ecap = 0;
    }
  }
  /* Without either index, a map is a linear scan; dead entries kept for an
   * active iteration are skipped by every later rebuild. */
  if (m->ndense > SCR_MAP_CLEAR_KEEP && m->ndense / 32 > walked) {
    scr_mem_free(m->dense);
    m->dense = NULL;
    m->ndense = 0;
  }
  if (m->nbuckets) {
    if (m->nbuckets > SCR_MAP_CLEAR_KEEP && m->nbuckets / 8 > walked) {
      scr_mem_free(m->buckets);
      m->buckets = NULL;
      m->nbuckets = 0;
    } else {
      bool compact = scr_map_compact_buckets(m->nbuckets);
      memset(m->buckets, compact ? 0 : 0xff,
             m->nbuckets * (compact ? sizeof(uint32_t) : sizeof(size_t)));
    }
  }
}

/* ── has / delete ──────────────────────────────────────────────────────── */

bool scr_map_has_f64(const ScrMap *m, double key) {
  return scr_map_find_f64(m, key) != SCR_MAP_EMPTY;
}

bool scr_map_has_str(const ScrMap *m, const ScrStr *key) {
  return scr_map_find_str(m, key) != SCR_MAP_EMPTY;
}

/* Tombstones beyond this share of the entries are compacted on delete, so
 * iteration and later rebuilds cost O(live) rather than O(peak). V8 shrinks
 * an ordered hash table at the same occupancy. Small maps keep theirs. */
#define SCR_MAP_SHRINK_MIN 64

static bool scr_map_delete_found(ScrMap *m, size_t e) {
  if (e == SCR_MAP_EMPTY) return false;
  uint64_t key = scr_map_at(m, e)->key, val = scr_map_val_at(m, e);
  scr_map_kill_at(m, e); /* bucket slot stays: probe chains intact */
  m->nlive--;
  if (m->ndense) m->dense[(size_t)scr_map_slot_to_f64(key)] = 0;
  /* Each such compaction follows deletes of three quarters of the entries,
   * so it is amortized constant per delete. It runs before the releases:
   * they may drop the last reference to this map. */
  if (__builtin_expect(m->iter_depth == 0 && m->nentries >= SCR_MAP_SHRINK_MIN &&
                       m->nlive < m->nentries / 4, 0)) {
    scr_map_compact(m, true);
  }
  scr_map_release_key(m, key);
  scr_map_release_val(m, val);
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

/* Append a key known to be absent. slot is the empty bucket found by the
 * probe (unused for linear storage). */
static void scr_map_append(ScrMap *m, uint64_t hash, uint64_t key, uint64_t val, size_t slot) {
  size_t old_entries = m->nentries, old_buckets = m->nbuckets;
  scr_map_reserve_append(m);
  /* Growth or compaction can move the insertion bucket. Otherwise keep the
   * empty slot from the first probe instead of walking the chain twice. */
  if (m->nbuckets && (m->nentries != old_entries || m->nbuckets != old_buckets)) {
    size_t mask = m->nbuckets - 1;
    slot = hash & mask;
    while (scr_map_bucket(m, slot) != SCR_MAP_EMPTY) slot = (slot + 1) & mask;
  }
  size_t idx = m->nentries++;
  scr_map_put_at(m, idx, key, val, hash);
  m->filter |= scr_map_filter_bits(hash);
  m->nlive++;
  if (m->key_kind == SCR_MAP_KEY_STR) {
    ScrStr *k = scr_map_slot_to_ptr(key); /* key is borrowed */
    if (__builtin_expect(scr_str_is_scratch(k), 0))
      scr_map_at(m, idx)->key = scr_map_slot_from_ptr(scr_str_scratch_keep(k));
    else
      scr_str_retain(k);
  } else if (m->key_kind == SCR_MAP_KEY_DYN) {
    const ScrDyn *d = (ScrDyn *)scr_map_slot_to_ptr(key);
    if (d->kind == SCR_DYN_NUM && d->v.num == 0) {
      /* Iteration returns +0 even when the inserted key was -0. Never
       * mutate the caller's shared box while normalizing a stored key. */
      scr_map_at(m, idx)->key = scr_map_slot_from_ptr(scr_dyn_new_num(0));
    } else {
      m->ops->key_retain(scr_map_slot_to_ptr(key));
    }
  } else if (m->key_kind == SCR_MAP_KEY_UNION_VALUE &&
             m->ops->union_keys[((ScrUnion *)scr_map_slot_to_ptr(key))->tag] == SCR_MAP_KEY_F64 &&
             ((ScrUnion *)scr_map_slot_to_ptr(key))->slot == UINT64_C(0x8000000000000000)) {
    /* Normalize stored -0 without mutating the caller's immutable box. */
    ScrUnion *u = scr_map_slot_to_ptr(key);
    scr_map_at(m, idx)->key = scr_map_slot_from_ptr(scr_union_new_f64(u->tag, 0));
  } else if (scr_map_ref_key(m->key_kind)) {
    m->ops->key_retain(scr_map_slot_to_ptr(key)); /* key is borrowed */
  }
  if (m->nbuckets) scr_map_bucket_set(m, slot, idx, hash);
}

/* The probe and overwrite are specialized by lookup kind like reads; the
 * append (allocation, growth, key ownership) stays shared. */
static inline __attribute__((always_inline)) void scr_map_set_with(
    ScrMap *m, uint64_t hash, uint64_t key, uint64_t val, ScrMapLookup lookup) {
  hash = hash ? hash : 1;
  size_t slot = SCR_MAP_EMPTY, e;
  if (m->nbuckets == 0) {
    e = scr_map_find_with(m, hash, key, lookup);
  } else {
    slot = scr_map_probe_with(m, hash, key, lookup);
    e = scr_map_bucket(m, slot);
  }
  if (e != SCR_MAP_EMPTY) {
    if (scr_map_lookup_c(lookup)) {
      /* Compact values are never counted: nothing to release. */
      ((ScrMapCEntry *)m->entries)[e].val = scr_map_cref_encode(val);
      return;
    }
    ScrMapEntry *x = scr_map_at_with(m, e, lookup);
    uint64_t old = x->val;
    x->val = val; /* unlink before releasing (cycle collector) */
    scr_map_release_val(m, old);
    return;
  }
  scr_map_append(m, hash, key, val, slot);
}

/* The insert of a SCR_MAP_VAL_CREF map, out of line so that the string-key
 * insert of other maps keeps its size. */
static __attribute__((noinline)) void scr_map_set_str_c(ScrMap *m, uint64_t hash, uint64_t key,
                                                        uint64_t val) {
  scr_map_set_with(m, hash, key, val, SCR_MAP_LOOKUP_STR_C);
}

static void scr_map_set_str_slot(ScrMap *m, uint64_t hash, uint64_t key, uint64_t val) {
  if (scr_map_cref(m)) {
    scr_map_set_str_c(m, hash, key, val);
    return;
  }
  scr_map_set_with(m, hash, key, val, SCR_MAP_LOOKUP_STR);
}

/* Out-of-line copies of the word-key insert: the generic dispatcher's, and
 * the hashed number-key path's below. */
static __attribute__((noinline)) void scr_map_set_word(ScrMap *m, uint64_t hash, uint64_t key,
                                                       uint64_t val) {
  scr_map_set_with(m, hash, key, val, SCR_MAP_LOOKUP_WORD);
}

static __attribute__((noinline)) void scr_map_set_num(ScrMap *m, uint64_t hash, uint64_t key,
                                                      uint64_t val) {
  scr_map_set_with(m, hash, key, val, SCR_MAP_LOOKUP_NUM);
}

/* A number-key map with at least this many entries moves to the direct
 * index when its keys allow it: from its second key, so a map of a few
 * small integer keys (a histogram over 0..3) reads through the inline
 * direct index rather than the out-of-line linear scan. A map with one
 * key keeps its linear storage. */
#define SCR_MAP_DENSE_AFTER 1

/* Whether appending one more entry would grow the lookup index rather than
 * reuse tombstones: scr_map_reserve_append compacts a linear map with a
 * dead entry, or a bucket table at most half live, whenever no iteration
 * is active. A linear map counts as growing from SCR_MAP_DENSE_AFTER
 * entries. Only real growth may move a number-key map to the direct
 * index; churn on a small map keeps its compact storage. */
static inline bool scr_map_append_grows_index(const ScrMap *m) {
  bool compacts = m->iter_depth == 0 && m->nentries > 0;
  if (m->nbuckets == 0)
    return m->nentries >= SCR_MAP_DENSE_AFTER && !(compacts && m->nlive < m->nentries);
  return m->nbuckets < 2 * (m->nentries + 1) && !(compacts && m->nlive <= m->nentries / 2);
}

/* Number keys arrive normalized (+0 for -0, canonical NaN). A directly
 * indexed map overwrites or appends through its table; a key the table
 * cannot hold converts it to hashing first. When an append would grow a
 * hashed map's index and the key could be indexed directly, the lookup that
 * decides whether the key is new also overwrites a key that is already
 * present. */
static void scr_map_set_f64_slot(ScrMap *m, uint64_t key, uint64_t val) {
  double k = scr_map_slot_to_f64(key);
  size_t slot;
  if (!m->ndense && scr_map_append_grows_index(m) &&
      scr_map_dense_slot(k, scr_map_dense_limit(m->nlive + 1), &slot)) {
    size_t e = scr_map_find_f64(m, k);
    if (e != SCR_MAP_EMPTY) {
      uint64_t old = scr_map_at(m, e)->val;
      scr_map_at(m, e)->val = val; /* unlink before releasing (cycle collector) */
      scr_map_release_val(m, old);
      return;
    }
    scr_map_enter_dense(m, k); /* the append would grow the index; the key fits a table */
  }
  if (m->ndense) {
    size_t i;
    if (scr_map_dense_slot(k, m->ndense, &i) || scr_map_grow_dense(m, k, &i)) {
      uint32_t entry = m->dense[i];
      if (entry) {
        uint64_t old = scr_map_at(m, entry - 1)->val;
        scr_map_at(m, entry - 1)->val = val; /* unlink before releasing (cycle collector) */
        scr_map_release_val(m, old);
        return;
      }
      if (m->nentries < UINT32_MAX - 1) {
        scr_map_reserve_append(m); /* may compact, which refills the table */
        size_t idx = m->nentries++;
        uint64_t hash = scr_map_hash_word(key);
        hash = hash ? hash : 1;
        scr_map_put_at(m, idx, key, val, hash);
        m->filter |= scr_map_filter_bits(hash);
        m->nlive++;
        m->dense[i] = (uint32_t)(idx + 1);
        return;
      }
    }
    scr_map_leave_dense(m);
  }
  scr_map_set_num(m, scr_map_hash_word(key), key, val);
}

static void scr_map_set(ScrMap *m, uint64_t hash, uint64_t key, uint64_t val) {
  if (m->key_kind == SCR_MAP_KEY_F64) {
    scr_map_set_f64_slot(m, key, val);
    return;
  }
  switch (scr_map_lookup_kind(m)) {
  case SCR_MAP_LOOKUP_STR: scr_map_set_str_slot(m, hash, key, val); return;
  case SCR_MAP_LOOKUP_STR_C: scr_map_set_str_c(m, hash, key, val); return;
  case SCR_MAP_LOOKUP_WORD: scr_map_set_word(m, hash, key, val); return;
  case SCR_MAP_LOOKUP_NUM: scr_map_set_num(m, hash, key, val); return;
  default: scr_map_set_with(m, hash, key, val, SCR_MAP_LOOKUP_GENERIC); return;
  }
}

static void scr_map_set_f64_key(ScrMap *m, double key, uint64_t val) {
  scr_map_set_f64_slot(m, scr_map_f64_bits(key), val); /* stores +0 for -0, canonical NaN */
}

static void scr_map_set_str_key(ScrMap *m, ScrStr *key, uint64_t val) {
  scr_map_set_str_slot(m, scr_map_hash_str(key), scr_map_slot_from_ptr(key), val);
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

/* ── get ───────────────────────────────────────────────────────────────── */

bool scr_map_get_f64_f64(const ScrMap *m, double key, double *out) {
  size_t e = scr_map_find_f64(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(scr_map_at(m, e)->val);
  return true;
}

bool scr_map_get_f64_bool(const ScrMap *m, double key, bool *out) {
  size_t e = scr_map_find_f64(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_at(m, e)->val != 0;
  return true;
}

void *scr_map_get_f64_ref(const ScrMap *m, double key) {
  size_t e = scr_map_find_f64(m, key);
  if (e == SCR_MAP_EMPTY) return NULL;
  return m->ops->val_retain(scr_map_slot_to_ptr(scr_map_at(m, e)->val)); /* +1 */
}

bool scr_map_get_str_f64(const ScrMap *m, const ScrStr *key, double *out) {
  size_t e = scr_map_find_str(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(scr_map_at(m, e)->val);
  return true;
}

bool scr_map_get_str_bool(const ScrMap *m, const ScrStr *key, bool *out) {
  size_t e = scr_map_find_str(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_at(m, e)->val != 0;
  return true;
}

/* scr_map_entry_str serves maps with 24-byte entries (generated code reads
 * a SCR_MAP_VAL_CREF map through scr_map_entry_str_c). */
static __attribute__((noinline)) const ScrMapEntry *scr_map_entry_str_slow(const ScrMap *m,
                                                                           const ScrStr *key) {
  if (m->nlive == 0) return NULL;
  size_t e = scr_map_find_with(m, scr_map_hash_str(key), scr_map_slot_from_ptr((void *)key),
                               SCR_MAP_LOOKUP_STR);
  return e == SCR_MAP_EMPTY ? NULL : &m->entries[e];
}

/* A stored key with the probe's hash but another identity: compare bytes.
 * Equal hashes of different strings are rare enough to answer by the
 * complete lookup. */
static __attribute__((noinline)) const ScrMapEntry *scr_map_entry_str_bytes(const ScrMap *m,
                                                                            const ScrStr *key,
                                                                            const ScrMapEntry *e) {
  const ScrStr *stored = scr_map_slot_to_ptr(e->key);
  if (stored->len == key->len && scr_key_equal(stored->data, key->data, key->len)) return e;
  return scr_map_entry_str_slow(m, key);
}

/* Every string-key read of generated code lands here. The common shapes, a
 * key with a cached hash probing linear or compact-bucket storage, run
 * without a stack frame: a hash match on another string object tail-calls
 * the byte comparison, and anything else (an uncached hash, wide buckets)
 * the complete lookup. */
const ScrMapEntry *scr_map_entry_str(const ScrMap *m, const ScrStr *key) {
#if SCR_STR_HASH_CACHE
  uint32_t h = key->hash;
  size_t nbuckets = m->nbuckets;
  if (__builtin_expect(h != 0 && scr_map_compact_buckets(nbuckets), 1)) {
    uint64_t hash = scr_map_hash_widen(h);
    uint64_t bits = scr_map_filter_bits(hash);
    if ((m->filter & bits) != bits) return NULL;
    const ScrMapEntry *entries = m->entries;
    if (nbuckets == 0) {
      for (size_t e = 0, n = m->nentries; e < n; e++) {
        if (entries[e].hash != hash) continue;
        if (entries[e].key == scr_map_slot_from_ptr((void *)key)) return &entries[e];
        return scr_map_entry_str_bytes(m, key, &entries[e]);
      }
      return NULL;
    }
    const uint32_t *buckets = m->buckets;
    uint32_t tag = (uint32_t)(hash >> 32 & UINT32_C(0xff000000));
    size_t mask = nbuckets - 1;
    for (size_t i = hash & mask;; i = (i + 1) & mask) {
      uint32_t bucket = buckets[i];
      if (!bucket) return NULL;
      if ((bucket & ~SCR_MAP_INDEX_MASK) != tag) continue;
      const ScrMapEntry *e = &entries[(bucket & SCR_MAP_INDEX_MASK) - 1];
      if (e->hash != hash) continue;
      if (e->key == scr_map_slot_from_ptr((void *)key)) return e;
      return scr_map_entry_str_bytes(m, key, e);
    }
  }
#endif
  return scr_map_entry_str_slow(m, key);
}

static __attribute__((noinline)) const ScrMapCEntry *scr_map_entry_str_c_slow(const ScrMap *m,
                                                                              const ScrStr *key) {
  size_t e = scr_map_find_str(m, key);
  return e == SCR_MAP_EMPTY ? NULL : scr_map_c_at(m, e);
}

static __attribute__((noinline)) const ScrMapCEntry *scr_map_entry_str_c_bytes(const ScrMap *m,
                                                                               const ScrStr *key,
                                                                               const ScrMapCEntry *e) {
  const ScrStr *stored = scr_map_slot_to_ptr(e->key);
  if (stored->len == key->len && scr_key_equal(stored->data, key->data, key->len)) return e;
  return scr_map_entry_str_c_slow(m, key);
}

/* scr_map_entry_str over a SCR_MAP_VAL_CREF map's 16-byte entries, whose
 * hash is the low half of the widened one. */
const ScrMapCEntry *scr_map_entry_str_c(const ScrMap *m, const ScrStr *key) {
#if SCR_STR_HASH_CACHE
  uint32_t h = key->hash;
  size_t nbuckets = m->nbuckets;
  if (__builtin_expect(h != 0 && scr_map_compact_buckets(nbuckets), 1)) {
    uint64_t hash = scr_map_hash_widen(h);
    uint64_t bits = scr_map_filter_bits(hash);
    if ((m->filter & bits) != bits) return NULL;
    const ScrMapCEntry *entries = (const ScrMapCEntry *)m->entries;
    if (nbuckets == 0) {
      for (size_t e = 0, n = m->nentries; e < n; e++) {
        if (entries[e].hash != h) continue;
        if (entries[e].key == scr_map_slot_from_ptr((void *)key)) return &entries[e];
        return scr_map_entry_str_c_bytes(m, key, &entries[e]);
      }
      return NULL;
    }
    const uint32_t *buckets = m->buckets;
    uint32_t tag = (uint32_t)(hash >> 32 & UINT32_C(0xff000000));
    size_t mask = nbuckets - 1;
    for (size_t i = hash & mask;; i = (i + 1) & mask) {
      uint32_t bucket = buckets[i];
      if (!bucket) return NULL;
      if ((bucket & ~SCR_MAP_INDEX_MASK) != tag) continue;
      const ScrMapCEntry *e = &entries[(bucket & SCR_MAP_INDEX_MASK) - 1];
      if (e->hash != h) continue;
      if (e->key == scr_map_slot_from_ptr((void *)key)) return e;
      return scr_map_entry_str_c_bytes(m, key, e);
    }
  }
#endif
  return scr_map_entry_str_c_slow(m, key);
}

void *scr_map_get_str_ref(const ScrMap *m, const ScrStr *key) {
  size_t e = scr_map_find_str(m, key);
  if (e == SCR_MAP_EMPTY) return NULL;
  return scr_map_val_retain(m, scr_map_val_at(m, e)); /* +1 */
}

bool scr_map_get_ref_f64(const ScrMap *m, const void *key, double *out) {
  size_t e = scr_map_find_ref(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_slot_to_f64(scr_map_at(m, e)->val);
  return true;
}

bool scr_map_get_ref_bool(const ScrMap *m, const void *key, bool *out) {
  size_t e = scr_map_find_ref(m, key);
  if (e == SCR_MAP_EMPTY) return false;
  *out = scr_map_at(m, e)->val != 0;
  return true;
}

void *scr_map_get_ref_ref(const ScrMap *m, const void *key) {
  size_t e = scr_map_find_ref(m, key);
  if (e == SCR_MAP_EMPTY) return NULL;
  return m->ops->val_retain(scr_map_slot_to_ptr(scr_map_at(m, e)->val));
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
  *out = scr_map_slot_to_f64(scr_map_at(m, entry)->val);
  return true;
}

bool scr_map_get_bool_bool(const ScrMap *m, bool key, bool *out) {
  size_t entry = scr_map_find_bool(m, key);
  if (entry == SCR_MAP_EMPTY) return false;
  *out = scr_map_at(m, entry)->val != 0;
  return true;
}

void *scr_map_get_bool_ref(const ScrMap *m, bool key) {
  size_t entry = scr_map_find_bool(m, key);
  if (entry == SCR_MAP_EMPTY) return NULL;
  return m->ops->val_retain(scr_map_slot_to_ptr(scr_map_at(m, entry)->val));
}

/* ── iteration primitives (the forEach desugar) ────────────────────────── */

double scr_map_iter_count(const ScrMap *m) { return (double)m->nentries; }

bool scr_map_iter_live(const ScrMap *m, double i) {
  if (!(i >= 0) || i >= (double)m->nentries) return false;
  return scr_map_live_at(m, (size_t)i);
}

/* A walk that starts at or below head moves head to the live entry it
 * finds, so the deleted prefix is walked once however many iterations
 * start there. A published map is read by other threads and keeps its
 * header unchanged. */
double scr_map_iter_skip(ScrMap *m, double i) {
  if (!(i < (double)m->nentries)) return i;
  bool from_head = !(i > (double)m->head);
  size_t e = from_head ? m->head : (size_t)i;
  while (e < m->nentries && !scr_map_live_at(m, e)) e++;
  if (from_head && m->rc != SIZE_MAX) m->head = (uint32_t)e;
  return e == (size_t)i ? i : (double)e;
}

double scr_map_iter_start(ScrMap *m) {
  return scr_map_iter_skip(m, 0);
}

static const ScrMapEntry *scr_map_iter_at(const ScrMap *m, double i) {
  if (!(i >= 0) || i >= (double)m->nentries || !scr_map_live_at(m, (size_t)i)) {
    scr_trap("scriptc: internal error: map iteration index out of range\n");
  }
  return scr_map_at(m, (size_t)i);
}

/* The value of the live entry at iteration index i as an 8-byte slot. */
static uint64_t scr_map_iter_val_slot(const ScrMap *m, double i) {
  (void)scr_map_iter_at(m, i);
  return scr_map_val_at(m, (size_t)i);
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
  return m->ops->key_retain(scr_map_slot_to_ptr(scr_map_iter_at(m, i)->key)); /* +1 */
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
  uint64_t slot = scr_map_iter_val_slot(map, index);
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
ScrMap *scr_map_clone(const ScrMap *source, bool keys_only, const ScrMapOps *ops) {
  ScrMap *out = scr_map_new((ScrMapKeyKind)source->key_kind,
                            keys_only ? SCR_MAP_VAL_F64 : (ScrMapValKind)source->val_kind,
                            ops ? ops : source->ops);
  size_t count = source->nlive;
  if (!count) return out;
  size_t entry_size = scr_map_entry_size(out);
  if (count > SIZE_MAX / entry_size || count > SIZE_MAX / 2 / sizeof(size_t)) scr_map_oom();
  out->entries = scr_mem_alloc(count * entry_size);
  if (!out->entries) scr_map_oom();
  out->ecap = (uint32_t)count;
  size_t top = 0;
  /* A key-only copy of a SCR_MAP_VAL_CREF map has the 24-byte layout: its
   * entries are copied field by field. */
  bool same_layout = scr_map_cref(source) == scr_map_cref(out);
  for (size_t i = 0; i < source->nentries; i++) {
    if (!scr_map_live_at(source, i)) continue;
    const ScrMapEntry *entry = scr_map_at(source, i);
    if (source->ndense) {
      size_t k = (size_t)scr_map_slot_to_f64(entry->key);
      if (k > top) top = k;
    }
    size_t e = out->nentries++;
    ScrMapEntry *copy = scr_map_at(out, e);
    if (__builtin_expect(same_layout, 1)) memcpy(copy, entry, entry_size);
    else scr_map_put_at(out, e, entry->key, keys_only ? 0 : scr_map_val_at(source, i), scr_map_hash_at(source, i));
    if (out->key_kind == SCR_MAP_KEY_STR) scr_str_retain(scr_map_slot_to_ptr(copy->key));
    else if (scr_map_ref_key(out->key_kind)) out->ops->key_retain(scr_map_slot_to_ptr(copy->key));
    if (keys_only) scr_map_val_put(out, e, 0);
    else if (out->val_kind == SCR_MAP_VAL_REF) out->ops->val_retain(scr_map_slot_to_ptr(copy->val));
  }
  out->nlive = (uint32_t)count;
  out->filter = source->filter;
  /* Size the copy's direct index for its own keys, not for the source's
   * peak; keys that are sparse for their count hash instead. */
  if (source->ndense && top / 2 < scr_map_dense_limit(count)) {
    scr_map_dense_alloc(out, scr_map_dense_size(top));
    scr_map_fill_dense(out);
    return out;
  }
  if (count <= SCR_MAP_LINEAR_LIMIT) return out;
  size_t buckets = 16;
  while (buckets < 2 * count) {
    if (buckets > SIZE_MAX / 2 / sizeof(size_t)) scr_map_oom();
    buckets *= 2;
  }
  scr_map_rebuild_buckets(out, buckets);
  return out;
}

const ScrMapOps scr_map_dyn_set_ops = {
  scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v, NULL, NULL, NULL, NULL
};
const ScrMapOps scr_map_dyn_map_ops = {
  scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v,
  scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v, NULL
};

/* A generic view can be backed by typed slots. Its copy must accept new
 * JavaScript values independently of that backing's narrower adapters. */
ScrMap *scr_map_clone_dyn(const ScrMap *source, bool keys_only) {
  ScrMap *out = keys_only ? scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_F64, &scr_map_dyn_set_ops)
                          : scr_map_new(SCR_MAP_KEY_DYN, SCR_MAP_VAL_REF, &scr_map_dyn_map_ops);
  for (size_t i = 0; i < source->nentries; i++) {
    if (!scr_map_live_at(source, i)) continue;
    ScrDyn *key = scr_map_dyn_key(source, (double)i);
    uint64_t value = keys_only ? 0 : scr_map_slot_from_ptr(scr_map_dyn_value(source, (double)i));
    scr_map_set(out, scr_map_hash_dyn(key), scr_map_slot_from_ptr(key), value);
    scr_dyn_release(key);
  }
  return out;
}

void scr_map_values_into(ScrMap *set, const ScrMap *source, bool checked) {
  for (size_t i = 0; i < source->nentries; i++) {
    if (!scr_map_live_at(source, i)) continue;
    uint64_t value = checked ? scr_map_slot_from_ptr(scr_map_dyn_value(source, (double)i)) : scr_map_val_at(source, i);
    if (set->key_kind == SCR_MAP_KEY_F64) value = scr_map_f64_bits(scr_map_slot_to_f64(value));
    scr_map_set(set, scr_map_hash_key(set, value), value, 0);
    if (checked) scr_dyn_release(scr_map_slot_to_ptr(value));
  }
}

ScrArr *scr_set_to_arr_dyn(const ScrMap *map) {
  static ScrArrOps dyn_ops = { scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v };
  ScrArr *out = scr_arr_new_ops(&dyn_ops, map->nlive);
  for (size_t i = 0; i < map->nentries; i++) {
    if (scr_map_iter_live(map, (double)i)) scr_arr_push_ref(out, scr_map_dyn_key(map, (double)i));
  }
  return out;
}

void *scr_map_iter_val_ref(const ScrMap *m, double i) {
  return scr_map_val_retain(m, scr_map_iter_val_slot(m, i)); /* +1 */
}

/* A published (immortal) map never changes, so iterating it needs no
 * compaction guard, and it must not be written: other threads read it. */
void scr_map_iter_enter(ScrMap *m) {
  if (m->rc != SIZE_MAX) m->iter_depth++;
}

void scr_map_iter_exit(ScrMap *m) {
  if (m->rc == SIZE_MAX) return;
  if (m->iter_depth > 0) m->iter_depth--;
  /* A churny callback may have left many tombstones; with no iteration
   * active they are safe to drop now (bounds memory under forEach-heavy
   * add/delete workloads). */
  if (m->iter_depth == 0 && m->nlive <= m->nentries / 2 && m->nentries >= 16) {
    scr_map_compact(m, true);
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
    if (i < values->cap && scr_arr_dense_state(values, i) == SCR_ARR_VALUE) {
      uint64_t key = scr_arr_dense_get(values, i);
      if (set->key_kind == SCR_MAP_KEY_F64) key = scr_map_f64_bits(scr_map_slot_to_f64(key));
      scr_map_set(set, scr_map_hash_key(set, key), key, 0);
    } else if (values->elem == SCR_ELEM_STR) {
      ScrStr *s = (ScrStr *)scr_arr_get_ref(values, (double)i); /* +1 */
      scr_map_set_str_f64(set, s, 0);                           /* borrows; retains stored copy */
      scr_str_release(s);
    } else if (scr_map_ref_key(set->key_kind)) {
      void *p = scr_arr_get_ref(values, (double)i); /* +1 */
      scr_map_set_ref_f64(set, p, 0);               /* borrows; retains stored copy */
      set->ops->key_release(p);
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
  size_t live = m->nlive;
  if (live > SIZE_MAX / sizeof(ScrKeyIndex)) scr_map_oom();
  ScrKeyIndex *indices = NULL;
  size_t count = 0;
  for (size_t i = 0; i < m->nentries; i++) {
    if (!scr_map_live_at(m, i)) continue;
    ScrStr *key = scr_map_slot_to_ptr(scr_map_at(m, i)->key);
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
    ScrStr *key = scr_map_slot_to_ptr(scr_map_at(m, indices[i].entry)->key);
    scr_arr_push_ref(out, scr_str_retain(key));
  }
  free(indices);
  for (size_t i = 0; i < m->nentries; i++) {
    if (!scr_map_live_at(m, i)) continue;
    ScrStr *key = scr_map_slot_to_ptr(scr_map_at(m, i)->key);
    uint32_t index;
    if (!scr_map_key_array_index(key, &index)) scr_arr_push_ref(out, scr_str_retain(key));
  }
  return out;
}

/* Publication (scr_message.c): cache a heap string's key hash before it
 * becomes immortal, after which no thread may write its header. */
void scr_str_hash_prime(ScrStr *s) {
  if (s && s->rc != SIZE_MAX) (void)scr_map_hash_str(s);
}
