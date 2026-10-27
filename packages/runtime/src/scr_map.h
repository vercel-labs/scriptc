/* scriptc runtime — Map and Set (scr_map.c). Included by scr_runtime.h, which
 * says where new declarations go. */
#ifndef SCR_MAP_H
#define SCR_MAP_H

#include "scr_array.h"

/* ── maps (scr_map.c) ───────────────────────────────────────────────
 * ES Map<K, V> with the compact-dict layout: a dense, insertion-ordered
 * entries array (deletions become tombstones; compaction happens on growth,
 * and NEVER while an iteration is active) plus an open-addressing bucket
 * table of entry indices. That is what gives JS's observable semantics for
 * free: forEach visits in insertion order, entries added during iteration
 * are visited (they append), deleted entries are skipped (tombstones), and
 * a delete + re-add moves the key to the end (Node-verified).
 *
 * Primitive keys compare by value and reference keys by identity. Numbers
 * use SameValueZero: NaN equals NaN and -0 is stored as +0. Union wrappers
 * are representations, never identities; their arm descriptors select
 * the primitive or reference comparison, including null and undefined.
 *
 * Values are one uniform kind per map (like ScrArr elements): f64, bool, or
 * a refcounted pointer whose RC entry points arrive in the map type's
 * ScrMapOps descriptor at construction (the SCR_BOX_OBJ technique — the
 * runtime cannot know per-class/per-record layouts). key_trace and
 * val_trace are non-NULL when their respective types carry cycle headers.
 * Either side can point back at its map, so either adapter requires a
 * hidden collector header. Trace visits each live edge on the traced sides;
 * collector teardown releases the untraced complement. Maps with neither
 * adapter use a lean RC header.
 *
 * Ownership: set BORROWS the key (the map retains string/reference keys it stores)
 * and OWNS the value (+1 moves in; replacing releases the old value).
 * get/has/delete borrow the key; get returns +1 on ref values (NULL = not
 * found) or fills an out-param and returns a found flag for scalars.
 * delete releases the entry's key and value. iter_key_str/ref and iter_val_ref
 * return +1. iter_enter/iter_exit bracket a forEach loop: while the depth
 * is nonzero, growth keeps tombstones (indices stay stable) and clear only
 * tombstones entries — live-iteration semantics stay exact.
 */

/* REF keys hash/compare pointer identity and carry their own RC adapters.
 * UNION_REF owns the union wrapper but hashes/compares its reference payload;
 * the frontend permits only unions of reference-identity arms for this kind.
 * DYN owns a checked-value box and compares its JavaScript value using
 * SameValueZero, including reference identity for object payloads.
 * These key kinds serve both Maps and Sets. */
typedef enum {
  SCR_MAP_KEY_F64, SCR_MAP_KEY_STR, SCR_MAP_KEY_REF, SCR_MAP_KEY_UNION_REF, SCR_MAP_KEY_DYN,
  SCR_MAP_KEY_BIGINT, SCR_MAP_KEY_BOOL, SCR_MAP_KEY_UNION_VALUE,
  SCR_MAP_KEY_NULL, SCR_MAP_KEY_UNDEFINED /* tag-only union arms */
} ScrMapKeyKind;
/* SCR_MAP_VAL_CREF: a string-key map whose values are compact class
 * instances in the program-lifetime region (llvm/classes.ts
 * LlClassMeta.compact). Its entries are ScrMapCEntry; the values are never
 * counted or traced. */
typedef enum { SCR_MAP_VAL_F64, SCR_MAP_VAL_BOOL, SCR_MAP_VAL_REF, SCR_MAP_VAL_CREF } ScrMapValKind;

typedef struct {
  uint64_t key; /* double bits (normalized), ScrStr* (owned), or ref ptr (owned) */
  uint64_t val; /* double bits, bool, or owned pointer */
  uint64_t hash; /* nonzero cached hash; zero = tombstone (key/val released) */
} ScrMapEntry;
/* A number-key map's (SCR_MAP_KEY_F64) entry: the key and the value, with
 * no cached hash. A dead entry's key is SCR_MAP_NUM_DEAD, a NaN pattern no
 * stored key has (stored keys use the one canonical NaN). */
typedef struct {
  uint64_t key;
  uint64_t val;
} ScrMapNumEntry;
#define SCR_MAP_NUM_DEAD UINT64_C(0x7ff0000000000001)
/* A SCR_MAP_VAL_CREF map's entry: the string key, the key's 32-bit hash
 * (its cached 64-bit hash is the same value in both halves,
 * scr_map.c scr_map_hash_widen; zero = tombstone), and the value as an
 * address over 8 (0 for NULL). */
typedef struct {
  uint64_t key;
  uint32_t hash;
  uint32_t val;
} ScrMapCEntry;

/* Checked views use the original storage. Slot converters borrow on reads
 * and return owned references on writes, just like typed Map operations. */
typedef struct {
  const char *type;
  struct ScrDyn *(*key_box)(uint64_t);
  uint64_t (*key_unbox)(const struct ScrDyn *);
  bool (*key_matches)(const struct ScrDyn *);
  struct ScrDyn *(*val_box)(uint64_t);
  uint64_t (*val_unbox)(const struct ScrDyn *);
} ScrMapDynOps;

/* The entry adapters of one collection type, shared by every map of that
 * type: an immutable descriptor that the compiler emits once per type (the
 * runtime's own maps use static ones). Reference-represented keys
 * (including bigint and union values) and SCR_MAP_VAL_REF values have
 * retain/release; a trace adapter is non-NULL iff that side's type carries
 * a cycle header. union_keys is a UNION_VALUE key's immutable key-kind
 * table, indexed by union tag. */
typedef struct ScrMapOps {
  void *(*key_retain)(void *);
  void (*key_release)(void *);
  ScrTraceFn key_trace;
  void *(*val_retain)(void *);
  void (*val_release)(void *);
  ScrTraceFn val_trace;
  const uint8_t *union_keys;
} ScrMapOps;

/* ScrMap.traced: the map has a collector header (either side can point
 * back at it) and traces the flagged sides. */
#define SCR_MAP_TRACED_KEY 1u
#define SCR_MAP_TRACED_VAL 2u

/* ScrMap.flags: SCR_MAP_NULL_PROTO marks the overflow map of a record
 * whose object has a null prototype (Object.groupBy results). Compiled
 * code sets and tests the byte; the runtime never copies it. */
#define SCR_MAP_NULL_PROTO 1u
/* Object.freeze, Object.seal or Object.preventExtensions of a Map or Set:
 * it has no own properties, so it is then frozen, sealed and not
 * extensible at once. Its entries stay writable, as in Node. */
#define SCR_MAP_NOT_EXTENSIBLE 2u

typedef struct ScrMap {
  size_t rc; /* SIZE_MAX = immortal (unused for maps; kept per convention) */
  uint8_t key_kind; /* ScrMapKeyKind */
  uint8_t val_kind; /* ScrMapValKind */
  uint8_t traced;   /* SCR_MAP_TRACED_KEY | SCR_MAP_TRACED_VAL, from ops */
  uint8_t flags;    /* SCR_MAP_NULL_PROTO */
  uint32_t iter_depth; /* > 0: an iteration is active — no compaction */
  const ScrMapOps *ops; /* never NULL */
  const ScrMapDynOps *dyn_ops;
  /* Counts and capacities are 32-bit: a map holds fewer than 2^30 entries
   * (scr_map_grow_entries), and its tables are sized from that. */
  uint32_t nentries; /* dense entries used, tombstones included */
  uint32_t nlive;    /* live entries (Map.size) */
  /* Two bits per inserted entry hash (scr_map.c scr_map_filter_bits): a
   * lookup whose bits are not all set is absent without touching the index
   * or the entries. Deletions leave their bits; compaction recomputes it. */
  uint64_t filter;
  ScrMapEntry *entries; /* NULL until the first insertion */
  uint32_t ecap;     /* entries capacity */
  uint32_t nbuckets; /* zero for small linear maps; otherwise power of two >= 2 * nentries */
  void *buckets;  /* compact tagged indices, or size_t indices for large tables */
  /* Direct index for number keys (SCR_MAP_KEY_F64 only). While ndense is
   * nonzero every live key is an integer in [0, ndense) and dense[k] holds
   * its entry index + 1 (0 = absent); the map then keeps no bucket table.
   * A key outside that shape moves the map to hashing; whenever the bucket
   * table would grow, compact integer keys move it back. Iteration order is
   * always the entries array's. */
  uint32_t *dense;
  uint32_t ndense;
  /* Every entry below this index is a tombstone. A walk that starts at or
   * below it advances it to the first live entry (scr_map_iter_skip);
   * compaction and clear reset it. A map that deletes from the front (a
   * queue, an LRU cache) then finds its first live entry without walking
   * the whole deleted prefix again. */
  uint32_t head;
} ScrMap;
/* The entry at index i of any layout, whether it is live, and its value as
 * an 8-byte slot (code that walks a map's entries outside scr_map.c). The
 * key is at byte 0 in every layout; a number-key entry has no hash field,
 * and a SCR_MAP_VAL_CREF entry keeps its value in 4 bytes. */
static inline const ScrMapEntry *scr_map_entry_at(const ScrMap *m, size_t i) {
  size_t size = m->key_kind == SCR_MAP_KEY_F64 ? sizeof(ScrMapNumEntry)
                : m->val_kind == SCR_MAP_VAL_CREF ? sizeof(ScrMapCEntry)
                                                  : sizeof(ScrMapEntry);
  return (const ScrMapEntry *)((const char *)m->entries + i * size);
}
static inline bool scr_map_entry_live(const ScrMap *m, size_t i) {
  const ScrMapEntry *e = scr_map_entry_at(m, i);
  if (m->key_kind == SCR_MAP_KEY_F64) return e->key != SCR_MAP_NUM_DEAD;
  if (m->val_kind == SCR_MAP_VAL_CREF) return ((const ScrMapCEntry *)e)->hash != 0;
  return e->hash != 0;
}
static inline uint64_t scr_map_entry_val(const ScrMap *m, const ScrMapEntry *e) {
  if (m->val_kind == SCR_MAP_VAL_CREF) return (uint64_t)((const ScrMapCEntry *)e)->val << 3;
  return e->val;
}
/* The LLVM backend reads the header through two types (emitter.ts). Its
 * inline retain/release test the traced byte as %ScrMapRc field 3, as
 * scr_map_retain and scr_map_release do. The inline number-key lookup
 * (sc_map_entry_f64) reads entries, dense and ndense as %ScrMapIx fields
 * 11, 15 and 16, and entries as %ScrMapNumEntry { key, val }; its hashed
 * probe (sc_map_entry_f64_hashed) also reads the entry count, the i64
 * filter, nbuckets and buckets as fields 8, 10, 13 and 14, and the inline
 * iteration steps read the entry count and test each entry: its hash, the
 * third field (sc_map_iter_entry), or for a number-key map its key against
 * SCR_MAP_NUM_DEAD (sc_map_iter_entry_num). Iteration over a checked
 * (unknown-key) Map or Set picks one of the two steps from the key kind,
 * %ScrMapIx field 1, compared with SCR_MAP_KEY_F64 (0). Map.size
 * (sc_map_size) reads the live count, field 9, as scr_map_size does. */
_Static_assert(offsetof(ScrMap, key_kind) == sizeof(size_t) && SCR_MAP_KEY_F64 == 0,
               "inline iteration over checked collections reads ScrMap.key_kind as %ScrMapIx field 1");
_Static_assert(offsetof(ScrMap, traced) == sizeof(size_t) + 2,
               "inline RC fast paths read ScrMap.traced as %ScrMapRc field 3");
_Static_assert(offsetof(ScrMap, flags) == sizeof(size_t) + 3,
               "compiled records read ScrMap.flags at byte offset sizeof(size_t) + 3");
_Static_assert(offsetof(ScrMap, iter_depth) == sizeof(size_t) + 4 &&
                   offsetof(ScrMap, ops) == sizeof(size_t) + 8 &&
                   offsetof(ScrMap, dyn_ops) == offsetof(ScrMap, ops) + sizeof(void *),
               "%ScrMapIx fields 5 to 7 are iter_depth, ops and dyn_ops");
_Static_assert(offsetof(ScrMap, nentries) == offsetof(ScrMap, dyn_ops) + sizeof(void *) &&
                   offsetof(ScrMap, nlive) == offsetof(ScrMap, nentries) + sizeof(uint32_t),
               "%ScrMapIx fields 8 and 9 are ScrMap.nentries and nlive");
_Static_assert(offsetof(ScrMap, filter) ==
                   (offsetof(ScrMap, nlive) + sizeof(uint32_t) + _Alignof(uint64_t) - 1) / _Alignof(uint64_t) * _Alignof(uint64_t),
               "%ScrMapIx field 10 is ScrMap.filter, directly after nlive");
_Static_assert(offsetof(ScrMap, entries) == offsetof(ScrMap, filter) + sizeof(uint64_t),
               "inline number-key lookups read ScrMap.entries as %ScrMapIx field 11");
_Static_assert(offsetof(ScrMap, ecap) == offsetof(ScrMap, entries) + sizeof(void *) &&
                   offsetof(ScrMap, nbuckets) == offsetof(ScrMap, ecap) + sizeof(uint32_t) &&
                   offsetof(ScrMap, buckets) == offsetof(ScrMap, nbuckets) + sizeof(uint32_t),
               "inline number-key probes read ScrMap.nbuckets and buckets as %ScrMapIx fields 13 and 14");
_Static_assert(offsetof(ScrMap, dense) == offsetof(ScrMap, buckets) + sizeof(void *) &&
                   offsetof(ScrMap, ndense) == offsetof(ScrMap, dense) + sizeof(void *),
               "inline number-key lookups read ScrMap.dense and ndense as %ScrMapIx fields 15 and 16");
_Static_assert(offsetof(ScrMapEntry, hash) == 16, "inline iteration reads ScrMapEntry.hash at byte 16");
_Static_assert(sizeof(ScrMapEntry) == 24 && offsetof(ScrMapEntry, val) == 8,
               "inline lookups read ScrMapEntry.val at byte 8");
_Static_assert(sizeof(ScrMapNumEntry) == 16 && offsetof(ScrMapNumEntry, val) == 8,
               "inline number-key lookups and iteration read %ScrMapNumEntry { key, val }");
_Static_assert(sizeof(ScrMapCEntry) == 16 && offsetof(ScrMapCEntry, hash) == 8 &&
                   offsetof(ScrMapCEntry, val) == 12,
               "inline compact-value lookups and iteration read %ScrMapCEntry { key, hash, val }");
_Static_assert(sizeof(ScrMap) <= 11 * sizeof(uint64_t), "the ScrMap header stays within 88 bytes");
/* Entry for a number key, or NULL when absent. The pointer is valid until
 * the next mutation; generated code reads the value slot through it. */
const ScrMapEntry *scr_map_entry_f64(const ScrMap *m, double key);
/* Entry for a string key, or NULL when absent, on the same terms. Typed
 * reference reads retain the value with its static type's retain instead
 * of the collection's adapter. */
const ScrMapEntry *scr_map_entry_str(const ScrMap *m, const ScrStr *key);
/* scr_map_entry_str for a SCR_MAP_VAL_CREF map: its entry is a
 * ScrMapCEntry. */
const ScrMapCEntry *scr_map_entry_str_c(const ScrMap *m, const ScrStr *key);

/* String-key lookups borrow an exact byte span. Reference results return
 * +1; scalar outputs are written only on a hit, like the string getters. */
bool scr_map_get_span_f64(const ScrMap *m, const char *bytes, size_t length, double *out);
bool scr_map_get_span_bool(const ScrMap *m, const char *bytes, size_t length, bool *out);
void *scr_map_get_span_ref(const ScrMap *m, const char *bytes, size_t length);

/* Fresh shallow copies with compact storage and independent mutation.
 * keys_only selects a Set; checked views materialize their boxed values.
 * A typed key-only copy takes `ops` for the Set (the source's key
 * adapters); NULL keeps the source's descriptor. */
ScrMap *scr_map_clone(const ScrMap *source, bool keys_only, const ScrMapOps *ops);
ScrMap *scr_map_clone_dyn(const ScrMap *source, bool keys_only);
/* The descriptors of a Set and a Map of checked values (SCR_MAP_KEY_DYN
 * keys; the Map's values are checked values too). */
extern const ScrMapOps scr_map_dyn_set_ops;
extern const ScrMapOps scr_map_dyn_map_ops;
void scr_map_values_into(ScrMap *set, const ScrMap *source, bool checked);

void scr_map_dyn_attach(ScrMap *map, const ScrMapDynOps *ops);
struct ScrDyn *scr_map_dyn_key(const ScrMap *map, double index);
struct ScrDyn *scr_map_dyn_value(const ScrMap *map, double index);
struct ScrDyn *scr_map_dyn_get(ScrMap *map, const struct ScrDyn *key);
bool scr_map_dyn_has(ScrMap *map, const struct ScrDyn *key, bool remove);
void scr_map_dyn_set(ScrMap *map, const struct ScrDyn *key, const struct ScrDyn *value, bool set);

/* `ops` describes the key and value adapters (ScrMapOps above); NULL means
 * none, for scalar keys and values. Reference values require retain and
 * release. Typed identity keys retain their original representation for
 * iteration. UNION_REF compares the wrapped reference, so reboxing cannot
 * change key identity. The compiler admits only unions of identity-bearing
 * arms. Either trace adapter requires a collector header on the map itself.
 * The descriptor must outlive the map. */
ScrMap *scr_map_new(ScrMapKeyKind key_kind, ScrMapValKind val_kind,
                    const ScrMapOps *ops); /* returns +1 */
ScrMap *scr_map_retain(ScrMap *m);
void scr_map_release(ScrMap *m); /* NULL-tolerant */
void *scr_map_retain_v(void *m);
void scr_map_release_v(void *m);
void scr_map_trace_v(void *m, ScrTraceVisit visit, void *ctx);

double scr_map_size(const ScrMap *m); /* live entries (Map.size) */
/* Object.freeze, seal and preventExtensions of a Map or Set
 * (SCR_MAP_NOT_EXTENSIBLE); immortal maps are left as they are. */
void scr_map_prevent_extensions(ScrMap *m);
bool scr_map_is_extensible(const ScrMap *m);
void scr_map_clear(ScrMap *m);

bool scr_map_has_f64(const ScrMap *m, double key);
bool scr_map_has_bool(const ScrMap *m, bool key);
bool scr_map_has_str(const ScrMap *m, const ScrStr *key);
bool scr_map_has_ref(const ScrMap *m, const void *key);
bool scr_map_delete_f64(ScrMap *m, double key);
bool scr_map_delete_bool(ScrMap *m, bool key);
bool scr_map_delete_str(ScrMap *m, const ScrStr *key);
bool scr_map_delete_ref(ScrMap *m, const void *key);

/* set: key borrowed (string/reference keys are retained when stored), value moves in
 * for _ref (replacing releases the old value; the stored key is kept, like
 * JS — only the value changes on overwrite). */
void scr_map_set_f64_f64(ScrMap *m, double key, double v);
void scr_map_set_f64_bool(ScrMap *m, double key, bool v);
void scr_map_set_f64_ref(ScrMap *m, double key, void *v);
void scr_map_set_bool_f64(ScrMap *m, bool key, double v);
void scr_map_set_bool_bool(ScrMap *m, bool key, bool v);
void scr_map_set_bool_ref(ScrMap *m, bool key, void *v);
void scr_map_set_str_f64(ScrMap *m, ScrStr *key, double v);
void scr_map_set_str_bool(ScrMap *m, ScrStr *key, bool v);
void scr_map_set_str_ref(ScrMap *m, ScrStr *key, void *v);
void scr_map_set_ref_f64(ScrMap *m, void *key, double v);
void scr_map_set_ref_bool(ScrMap *m, void *key, bool v);
void scr_map_set_ref_ref(ScrMap *m, void *key, void *v);

/* get: scalar variants fill *out and return the found flag; ref variants
 * return +1 or NULL (values are never NULL, so NULL means "absent"). The
 * compiler wraps the result into the `V | undefined` union type-directedly
 * (the runtime knows no tags). */
bool scr_map_get_f64_f64(const ScrMap *m, double key, double *out);
bool scr_map_get_f64_bool(const ScrMap *m, double key, bool *out);
void *scr_map_get_f64_ref(const ScrMap *m, double key);
bool scr_map_get_bool_f64(const ScrMap *m, bool key, double *out);
bool scr_map_get_bool_bool(const ScrMap *m, bool key, bool *out);
void *scr_map_get_bool_ref(const ScrMap *m, bool key);
bool scr_map_get_str_f64(const ScrMap *m, const ScrStr *key, double *out);
bool scr_map_get_str_bool(const ScrMap *m, const ScrStr *key, bool *out);
void *scr_map_get_str_ref(const ScrMap *m, const ScrStr *key);
bool scr_map_get_ref_f64(const ScrMap *m, const void *key, double *out);
bool scr_map_get_ref_bool(const ScrMap *m, const void *key, bool *out);
void *scr_map_get_ref_ref(const ScrMap *m, const void *key);

/* Iteration primitives behind the compiler's forEach desugar: an index loop
 * over the dense entries array, re-reading iter_count every pass (appends
 * during iteration are visited) and skipping tombstones via iter_live.
 * iter_key/iter_val on an out-of-range or dead index abort (the desugar
 * guards with iter_live first — reaching one is a compiler bug). */
double scr_map_iter_count(const ScrMap *m); /* entries incl. tombstones */
bool scr_map_iter_live(const ScrMap *m, double i);
/* The first live index at or after i, or iter_count when none is left.
 * iter_start is the first live index of the map (for-of starts there). */
double scr_map_iter_skip(ScrMap *m, double i);
double scr_map_iter_start(ScrMap *m);
double scr_map_iter_key_f64(const ScrMap *m, double i);
bool scr_map_iter_key_bool(const ScrMap *m, double i);
ScrStr *scr_map_iter_key_str(const ScrMap *m, double i); /* +1 */
void *scr_map_iter_key_ref(const ScrMap *m, double i);     /* +1 */
double scr_map_iter_val_f64(const ScrMap *m, double i);
bool scr_map_iter_val_bool(const ScrMap *m, double i);
void *scr_map_iter_val_ref(const ScrMap *m, double i); /* +1 */
void scr_map_iter_enter(ScrMap *m);
void scr_map_iter_exit(ScrMap *m);

/* Seeded Set construction (`new Set(values)`): add() every element of one
 * borrowed T[] in order — duplicates keep their first insertion position
 * (SameValueZero, exactly JS). `set` is a set-shaped map (f64 value kind,
 * stored values 0); the array's element kind matches the set's key kind. */
void scr_set_add_all(ScrMap *set, ScrArr *values);

/* `[...set]` (scr_lib.c): the live entries drained into a fresh +1 elem[]
 * in insertion order. Borrows the set; string elements retained in. */
ScrArr *scr_set_to_arr_f64(const ScrMap *s);
ScrArr *scr_set_to_arr_bool(const ScrMap *s);
ScrArr *scr_set_to_arr_str(const ScrMap *s);
ScrArr *scr_set_to_arr_ref(const ScrMap *s, const ScrArrOps *ops);
ScrArr *scr_set_to_arr_dyn(const ScrMap *s);

/* The live STRING keys of a map in JS OWN-KEY ORDER (Object.keys/values/
 * entries over an index-signature record's overflow): canonical array
 * indices first in ascending numeric order, then the rest in insertion
 * order. Fresh ScrStr* array (+1); the map is borrowed. */
ScrArr *scr_map_keys_js_order(const ScrMap *m);

#ifdef SCR_RC_AUDIT
long scr_map_live_count(void);
/* Publication makes objects immortal and never frees them, so the RC audit
 * stops counting them (scr_message.c). */
void scr_str_live_forget(void);
void scr_dyn_live_forget(void);
void scr_arr_live_forget(void);
void scr_map_live_forget(void);
void scr_union_live_forget(void);
#endif

/* For the same reason LeakSanitizer must not report a published object
 * whose last reference is dropped (scr_message.c, scr_publish.c). Ignored
 * chunks are leak-scan roots, so everything an immortal object reaches is
 * covered and the verdict on the rest of the heap is unchanged. Weak: ASan
 * runtimes without a leak checker leave it NULL; other builds compile the
 * hook away. */
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_LSAN_IMMORTAL 1
void __lsan_ignore_object(const void *p) __attribute__((weak));
#endif
#endif
static inline void scr_lsan_immortal(const void *obj) {
#ifdef SCR_LSAN_IMMORTAL
  if (__lsan_ignore_object) __lsan_ignore_object(obj);
#else
  (void)obj;
#endif
}

#endif /* SCR_MAP_H */
